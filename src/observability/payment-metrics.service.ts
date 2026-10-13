import { Injectable, Logger } from '@nestjs/common';
import { metrics, ValueType } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';
import {
  PaymentProvider,
  PaymentStatus,
} from '../payments/entities/payment.entity';

@Injectable()
export class PaymentMetricsService {
  private readonly logger = new Logger(PaymentMetricsService.name);
  private warned = false;
  private readonly created?: Counter;
  private readonly approved?: Counter;
  private readonly rejected?: Counter;
  private readonly received?: Counter;
  private readonly invalid?: Counter;
  private readonly processingDuration?: Histogram;

  constructor() {
    // Reutiliza el proveedor global iniciado por auto-instrumentations-node/register.
    // Sin SDK activo, la API es no-op: no se crea aquí un proveedor alternativo.
    const meter = this.safely(() =>
      metrics.getMeter('servicio-a.payment-business', '1.0.0'),
    );
    const counter = (name: string, description: string) =>
      this.safely(() =>
        meter?.createCounter(name, { description, valueType: ValueType.INT }),
      );
    // Sin sufijo _total: la traducción OTLP -> Prometheus puede añadirlo.
    this.created = counter('payments_created', 'Pagos creados y persistidos');
    this.approved = counter(
      'payments_approved',
      'Transiciones persistidas a APPROVED',
    );
    this.rejected = counter(
      'payments_rejected',
      'Transiciones persistidas a REJECTED',
    );
    this.received = counter(
      'webhooks_received',
      'Solicitudes recibidas de WebHook',
    );
    this.invalid = counter(
      'webhooks_invalid',
      'WebHooks rechazados por autenticación',
    );
    this.processingDuration = this.safely(() =>
      meter?.createHistogram('webhook_processing_duration', {
        description: 'Tiempo de procesamiento del WebHook en Service A',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
          ],
        },
      }),
    );
  }

  paymentCreated(provider: PaymentProvider): void {
    this.safely(() => this.created?.add(1, { provider }));
  }

  paymentConfirmed(provider: PaymentProvider, status: PaymentStatus): void {
    const counter =
      status === PaymentStatus.APPROVED
        ? this.approved
        : status === PaymentStatus.REJECTED
          ? this.rejected
          : undefined;
    this.safely(() => counter?.add(1, { provider }));
  }

  webhookReceived(provider: PaymentProvider): void {
    this.safely(() => this.received?.add(1, { provider }));
  }

  webhookInvalid(provider: PaymentProvider): void {
    this.safely(() => this.invalid?.add(1, { provider }));
  }

  recordWebhookDuration(provider: PaymentProvider, seconds: number): void {
    this.safely(() => this.processingDuration?.record(seconds, { provider }));
  }

  private safely<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch {
      if (!this.warned) {
        this.warned = true;
        // No imprimir errores del SDK: pueden contener configuración sensible.
        this.logger.warn(
          'No se pudo registrar una métrica; el negocio continúa',
        );
      }
      return undefined;
    }
  }
}
