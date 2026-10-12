import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

// Contrato completo: ONVO_CONTRACT.md. La URL base es la misma para pruebas y producción:
// lo que decide el modo es el prefijo de la clave (onvo_test_... / onvo_live_...).
export const ONVO_API_URL = 'https://api.onvopay.com';
export const ONVO_CURRENCY = 'CRC';
const REQUEST_TIMEOUT_MS = 10_000;

// Solo los campos que Service A usa. ONVO devuelve más, pero su forma exacta no está
// documentada públicamente (ver "Pendientes" del contrato), así que no dependemos de ella.
export interface OnvoPaymentIntent {
  id: string;
  status: string;
  metadata?: Record<string, string>;
}

export interface CreateOnvoPaymentIntent {
  // Nuestro Payment.id (UUID). Vuelve en data.metadata.paymentId del webhook.
  paymentId: string;
  // En colones, como lo guarda Payment.amount. Aquí se convierte a centavos.
  amount: number;
  description: string;
}

// ONVO recibe el monto en la unidad más pequeña de la moneda: ₡15 000 -> 1 500 000.
// Math.round evita errores de punto flotante (0.07 * 100 = 7.000000000000001).
export function toCentavos(amountInColones: number): number {
  return Math.round(amountInColones * 100);
}

@Injectable()
export class OnvoClient {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async createPaymentIntent(
    input: CreateOnvoPaymentIntent,
  ): Promise<OnvoPaymentIntent> {
    const data = await this.request<unknown>('post', '/v1/payment-intents', {
      amount: toCentavos(input.amount),
      currency: ONVO_CURRENCY,
      description: input.description,
      metadata: { paymentId: input.paymentId },
    });
    return this.parseIntent(data);
  }

  async getPaymentIntent(id: string): Promise<OnvoPaymentIntent> {
    const data = await this.request<unknown>(
      'get',
      `/v1/payment-intents/${encodeURIComponent(id)}`,
    );
    return this.parseIntent(data);
  }

  // Para fallar ANTES de crear registros si falta configuración, en vez de dejar un pago a medias.
  assertConfigured(): void {
    this.getSecretKey();
    this.getPublishableKey();
  }

  // La clave publicable está pensada para el navegador (el SDK de ONVO la necesita);
  // la secreta nunca sale de Service A.
  getPublishableKey(): string {
    return this.requireConfig('ONVO_PUBLISHABLE_KEY');
  }

  private getSecretKey(): string {
    return this.requireConfig('ONVO_SECRET_KEY');
  }

  private requireConfig(name: string): string {
    const value = this.configService.get<string>(name);
    if (!value) {
      throw new InternalServerErrorException(`Falta configurar ${name}`);
    }
    return value;
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const secretKey = this.getSecretKey();

    const url = `${ONVO_API_URL}${path}`;
    const config = {
      headers: { Authorization: `Bearer ${secretKey}` },
      timeout: REQUEST_TIMEOUT_MS,
    };

    try {
      const response = await firstValueFrom(
        method === 'post'
          ? this.httpService.post<T>(url, body, config)
          : this.httpService.get<T>(url, config),
      );
      return response.data;
    } catch (error) {
      throw this.toHttpException(error, secretKey);
    }
  }

  private parseIntent(data: unknown): OnvoPaymentIntent {
    const intent = data as Partial<OnvoPaymentIntent> | null | undefined;
    if (
      !intent ||
      typeof intent.id !== 'string' ||
      typeof intent.status !== 'string'
    ) {
      throw new BadGatewayException(
        'ONVO respondió sin id o sin status del Payment Intent',
      );
    }
    return { id: intent.id, status: intent.status, metadata: intent.metadata };
  }

  // Convierte un error de axios en una excepción de Nest. Nunca incluye la clave en el mensaje.
  private toHttpException(error: unknown, secretKey: string) {
    const described = describeAxiosError(error);
    const status = described.status;
    const detail = described.detail.split(secretKey).join('[clave oculta]');
    if (status !== undefined && status < 500) {
      return new BadGatewayException(
        `ONVO rechazó la solicitud (HTTP ${status}): ${detail}`,
      );
    }
    return new ServiceUnavailableException(
      `No se pudo comunicar con ONVO: ${detail}`,
    );
  }
}

function describeAxiosError(error: unknown): {
  status: number | undefined;
  detail: string;
} {
  const e = error as {
    response?: { status?: number; data?: { message?: unknown } };
    message?: unknown;
  };
  const message = e?.response?.data?.message;
  const detail = Array.isArray(message)
    ? message.join(', ')
    : typeof message === 'string'
      ? message
      : typeof e?.message === 'string'
        ? e.message
        : 'error desconocido';
  return { status: e?.response?.status, detail };
}
