import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from '../payments/entities/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

// Eventos de ONVO que nos interesan (ONVO_CONTRACT.md, sección 5). Cualquier otro se
// responde 200 y se ignora, para que ONVO no lo reintente.
const ONVO_SUCCEEDED = 'payment-intent.succeeded';
const ONVO_FAILED = 'payment-intent.failed';
const ONVO_DEFERRED = 'payment-intent.deferred';

export interface OnvoWebhookResult {
  message: string;
  applied: boolean;
  payment?: Payment;
}

interface OnvoEvent {
  type: string;
  intentId: string | undefined;
  metadataPaymentId: string | undefined;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly onvoClient: OnvoClient,
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

  // ONVO no firma el cuerpo con HMAC: manda un secreto fijo en X-Webhook-Secret.
  // Como ese secreto no protege el contenido ni evita repeticiones, el estado final sale de
  // consultar el Payment Intent a ONVO (salvo ONVO_VERIFY_EVENTS=false), no del cuerpo.
  async processOnvo(
    rawBody: Buffer | undefined,
    secretHeader: string | undefined,
  ): Promise<OnvoWebhookResult> {
    const expectedSecret = this.configService.get<string>(
      'ONVO_WEBHOOK_SECRET',
    );
    if (!expectedSecret) {
      throw new InternalServerErrorException(
        'Falta configurar ONVO_WEBHOOK_SECRET',
      );
    }
    if (!secretHeader || !sameSecret(secretHeader, expectedSecret)) {
      throw new UnauthorizedException('X-Webhook-Secret ausente o inválido');
    }

    const event = parseOnvoEvent(rawBody);
    if (
      event.type !== ONVO_SUCCEEDED &&
      event.type !== ONVO_FAILED &&
      event.type !== ONVO_DEFERRED
    ) {
      return {
        message: `Evento ${event.type} ignorado: no se usa en este sistema`,
        applied: false,
      };
    }
    if (!event.intentId) {
      throw new BadRequestException('El evento no trae data.id');
    }

    const payment = await this.paymentsService.findOnvoPayment(
      event.intentId,
      event.metadataPaymentId,
    );
    if (!payment) {
      // 200 y no 404: otro evento de la misma cuenta ONVO no es un error nuestro.
      this.logger.warn(
        `Webhook ONVO ${event.type} sin pago asociado (intent ${event.intentId})`,
      );
      return {
        message: 'No hay un pago ONVO asociado a este evento; se ignora',
        applied: false,
      };
    }

    if (event.type === ONVO_DEFERRED) {
      return {
        message: 'Pago en proceso en ONVO; sigue pendiente',
        applied: false,
        payment,
      };
    }

    const succeededEvent = event.type === ONVO_SUCCEEDED;
    if (this.shouldVerifyWithOnvo()) {
      // Si la consulta falla, el error sube (502/503): solo se responde 2xx cuando se procesó.
      const intent = await this.onvoClient.getPaymentIntent(event.intentId);
      const owner = intent.metadata?.paymentId;
      if (owner !== undefined && owner !== payment.id) {
        this.logger.warn(
          `Webhook ONVO ignorado: el intent ${event.intentId} pertenece a otro pago`,
        );
        return {
          message: 'El Payment Intent no corresponde a este pago; se ignora',
          applied: false,
          payment,
        };
      }
      const succeededInOnvo = intent.status === 'succeeded';
      if (succeededEvent !== succeededInOnvo) {
        this.logger.warn(
          `Webhook ONVO ${event.type} no coincide con el estado real (${intent.status}); se ignora`,
        );
        return {
          message: `ONVO informa el estado ${intent.status}; el evento no se aplica`,
          applied: false,
          payment,
        };
      }
    }

    const { applied, payment: current } =
      await this.paymentsService.confirmPayment(
        payment.id,
        succeededEvent ? PaymentStatus.APPROVED : PaymentStatus.REJECTED,
        PaymentProvider.ONVO,
      );
    return {
      message: applied
        ? 'Webhook de ONVO recibido y verificado'
        : 'Webhook de ONVO ya procesado; no se aplicaron cambios',
      applied,
      payment: current,
    };
  }

  private shouldVerifyWithOnvo(): boolean {
    return this.configService.get<string>('ONVO_VERIFY_EVENTS') !== 'false';
  }
}

// Compara sin filtrar por tiempo ni por longitud: se comparan los hashes, que miden lo mismo.
function sameSecret(received: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(received), hash(expected));
}

// El sobre de ONVO es { type, data } sin id de evento ni fecha. data es el Payment Intent.
function parseOnvoEvent(rawBody: Buffer | undefined): OnvoEvent {
  if (!rawBody?.length) {
    throw new BadRequestException('Body vacío');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException('Payload JSON inválido');
  }
  const body = asRecord(payload);
  if (!body || typeof body.type !== 'string') {
    throw new BadRequestException('El evento no trae type');
  }
  const data = asRecord(body.data);
  const metadata = asRecord(data?.metadata);
  return {
    type: body.type,
    intentId: typeof data?.id === 'string' ? data.id : undefined,
    metadataPaymentId:
      typeof metadata?.paymentId === 'string' ? metadata.paymentId : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
