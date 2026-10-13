import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { performance } from 'node:perf_hooks';
import { PaymentProvider } from '../payments/entities/payment.entity';
import { PaymentMetricsService } from '../observability/payment-metrics.service';
import { SimulacionDto } from './dto/simulacion.dto';
import { WebhookLogService, WebhookOutcome } from './webhook-log.service';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly webhookLog: WebhookLogService,
    private readonly metrics: PaymentMetricsService,
  ) {}

  @Post('payments')
  @HttpCode(200)
  receivePaymentWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
  ) {
    return this.handle(req, signature, PaymentProvider.FAKE, () =>
      this.webhooksService.verifyAndProcess(req.rawBody, signature),
    );
  }

  // Webhook de ONVO. Su secreto (X-Webhook-Secret) nunca se guarda en el registro.
  @Post('onvo')
  @HttpCode(200)
  receiveOnvoWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-secret') secret: string | undefined,
  ) {
    return this.handle(req, undefined, PaymentProvider.ONVO, () =>
      this.webhooksService.processOnvo(req.rawBody, secret),
    );
  }

  private async handle(
    req: RawBodyRequest<Request>,
    loggedSignature: string | undefined,
    provider: PaymentProvider,
    process: () => Promise<{ applied: boolean; message: string }>,
  ) {
    const started = performance.now();
    const storeDown = this.webhookLog.isStoreDown();
    const log = (
      httpStatus: number,
      outcome: WebhookOutcome,
      signatureValid: boolean | null,
      message: string,
    ) =>
      this.webhookLog.record({
        rawBody: req.rawBody,
        signature: loggedSignature,
        httpStatus,
        outcome,
        signatureValid,
        message,
      });

    try {
      if (storeDown) {
        const message = 'La tienda está caída (simulación de la demo)';
        log(503, 'STORE_DOWN', null, message);
        throw new ServiceUnavailableException(message);
      }
      const result = await process();
      log(200, result.applied ? 'APPLIED' : 'DUPLICATE', true, result.message);
      return result;
    } catch (error) {
      // La simulación ya dejó su registro STORE_DOWN; no duplicarlo.
      if (storeDown) {
        throw error;
      }
      const status = error instanceof HttpException ? error.getStatus() : 500;
      log(
        status,
        status === 401 ? 'INVALID_SIGNATURE' : 'REJECTED',
        status === 401 ? false : status === 500 ? null : true,
        errorMessage(error),
      );
      throw error;
    } finally {
      this.metrics.recordWebhookDuration(
        provider,
        (performance.now() - started) / 1000,
      );
    }
  }

  // Evidencia del lado receptor: todo lo que llegó, aceptado o rechazado.
  @Get('recibidos')
  findReceived() {
    return this.webhookLog.findAll();
  }

  @Get('simulacion')
  getSimulation() {
    return { storeDown: this.webhookLog.isStoreDown() };
  }

  @Put('simulacion')
  setSimulation(@Body() dto: SimulacionDto) {
    return this.webhookLog.setStoreDown(dto.storeDown);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'object' && response !== null
        ? (response as { message?: unknown }).message
        : response;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : 'Error inesperado';
}
