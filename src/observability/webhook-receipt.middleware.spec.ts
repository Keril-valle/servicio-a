import type { Request, Response } from 'express';
import { PaymentProvider } from '../payments/entities/payment.entity';
import { PaymentMetricsService } from './payment-metrics.service';
import { createWebhookReceiptMiddleware } from './webhook-receipt.middleware';

describe('Webhook receipt middleware', () => {
  it.each([
    ['POST', '/webhooks/payments', PaymentProvider.FAKE],
    ['POST', '/webhooks/onvo/', PaymentProvider.ONVO],
    ['POST', '/WEBHOOKS/ONVO', PaymentProvider.ONVO],
    ['GET', '/webhooks/payments', undefined],
    ['POST', '/payments', undefined],
    ['POST', '/webhooks/simulacion', undefined],
    ['POST', '/webhooks/onvo/extra', undefined],
  ])(
    'filtra %s %s y siempre continúa la solicitud',
    (method, path, provider) => {
      const metrics = { webhookReceived: jest.fn() };
      const next = jest.fn();
      createWebhookReceiptMiddleware(
        metrics as unknown as PaymentMetricsService,
      )({ method, path } as Request, {} as Response, next);
      if (provider) {
        expect(metrics.webhookReceived).toHaveBeenCalledTimes(1);
        expect(metrics.webhookReceived).toHaveBeenCalledWith(provider);
      } else {
        expect(metrics.webhookReceived).not.toHaveBeenCalled();
      }
      expect(next).toHaveBeenCalledTimes(1);
    },
  );
});
