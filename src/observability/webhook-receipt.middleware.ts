import type { RequestHandler } from 'express';
import { PaymentProvider } from '../payments/entities/payment.entity';
import { PaymentMetricsService } from './payment-metrics.service';

// Registrar antes del parser JSON para incluir cuerpos malformados y rechazos 400/413.
// Solo cuenta recepción; autenticidad y duración se registran al procesar el WebHook.
export function createWebhookReceiptMiddleware(
  metrics: PaymentMetricsService,
): RequestHandler {
  return (req, _res, next) => {
    const route = /^\/webhooks\/(payments|onvo)\/?$/i.exec(req.path);
    if (req.method === 'POST' && route) {
      metrics.webhookReceived(
        route[1].toLowerCase() === 'onvo'
          ? PaymentProvider.ONVO
          : PaymentProvider.FAKE,
      );
    }
    next();
  };
}
