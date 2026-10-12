import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type WebhookOutcome =
  'APPLIED' | 'DUPLICATE' | 'INVALID_SIGNATURE' | 'STORE_DOWN' | 'REJECTED';

export interface ReceivedWebhook {
  id: string;
  receivedAt: string;
  httpStatus: number;
  outcome: WebhookOutcome;
  // null cuando la firma ni siquiera se revisó (tienda caída o falta configuración).
  signatureValid: boolean | null;
  message: string;
  signature: string | null;
  body: string;
  paymentId: string | null;
  status: string | null;
}

const MAX_ENTRIES = 100;
const MAX_BODY_CHARS = 4000;

// Registro en memoria de todo lo que llega a POST /webhooks/payments, incluido lo rechazado.
// También guarda el interruptor de la demo que simula que la tienda está caída.
@Injectable()
export class WebhookLogService {
  private readonly entries: ReceivedWebhook[] = [];
  private storeDown = false;

  isStoreDown() {
    return this.storeDown;
  }

  setStoreDown(storeDown: boolean) {
    this.storeDown = storeDown;
    return { storeDown };
  }

  record(entry: {
    rawBody: Buffer | undefined;
    signature: string | undefined;
    httpStatus: number;
    outcome: WebhookOutcome;
    signatureValid: boolean | null;
    message: string;
  }): ReceivedWebhook {
    const body = entry.rawBody?.toString('utf8') ?? '';
    const { paymentId, status } = peek(body);
    const received: ReceivedWebhook = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      httpStatus: entry.httpStatus,
      outcome: entry.outcome,
      signatureValid: entry.signatureValid,
      message: entry.message,
      signature: entry.signature ?? null,
      body: body.slice(0, MAX_BODY_CHARS),
      paymentId,
      status,
    };
    this.entries.push(received);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    return received;
  }

  findAll(): ReceivedWebhook[] {
    return [...this.entries].reverse();
  }
}

// Lee paymentId y status aunque el mensaje sea falso, para mostrar qué se intentó cambiar.
function peek(body: string): {
  paymentId: string | null;
  status: string | null;
} {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      paymentId: typeof parsed.paymentId === 'string' ? parsed.paymentId : null,
      status: typeof parsed.status === 'string' ? parsed.status : null,
    };
  } catch {
    return { paymentId: null, status: null };
  }
}
