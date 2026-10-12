import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from '../payments/entities/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async verifyAndProcess(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ) {
    if (!rawBody?.length) {
      throw new UnauthorizedException('Body vacío');
    }
    if (!signature || !/^[a-f\d]{64}$/i.test(signature)) {
      throw new UnauthorizedException(
        'Falta X-Signature o su formato es inválido',
      );
    }

    const secret = this.configService.get<string>('HMAC_SECRET');
    if (!secret) {
      throw new InternalServerErrorException('Falta configurar HMAC_SECRET');
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const actual = Buffer.from(signature, 'hex');
    if (!timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Firma HMAC inválida');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Payload JSON inválido');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Payload inválido');
    }
    const dto = plainToInstance(PaymentWebhookDto, payload);
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }

    const { applied, payment } = await this.paymentsService.confirmPayment(
      dto.paymentId,
      dto.status,
      PaymentProvider.FAKE,
    );
    return {
      message: applied
        ? 'Webhook recibido y verificado'
        : 'Webhook ya procesado; no se aplicaron cambios',
      applied,
      payment,
    };
  }
}
