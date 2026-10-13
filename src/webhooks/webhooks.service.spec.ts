import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PaymentMetricsService } from '../observability/payment-metrics.service';
import { PaymentProvider } from '../payments/entities/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

describe('WebhooksService: métricas de autenticación', () => {
  let config: Record<string, string | undefined>;
  let metrics: { webhookInvalid: jest.Mock };
  let service: WebhooksService;

  beforeEach(() => {
    config = { HMAC_SECRET: 'test-only-hmac' };
    metrics = { webhookInvalid: jest.fn() };
    service = new WebhooksService(
      { get: (name: string) => config[name] } as unknown as ConfigService,
      {} as PaymentsService,
      {} as OnvoClient,
      metrics as unknown as PaymentMetricsService,
    );
  });

  it('cuenta body ausente como el rechazo de autenticación FAKE existente', async () => {
    await expect(
      service.verifyAndProcess(undefined, undefined),
    ).rejects.toMatchObject({ status: 401 });
    expect(metrics.webhookInvalid).toHaveBeenCalledTimes(1);
    expect(metrics.webhookInvalid).toHaveBeenCalledWith(PaymentProvider.FAKE);
  });

  it('HMAC_SECRET no configurado es un fallo interno, no firma inválida', async () => {
    config.HMAC_SECRET = undefined;
    await expect(
      service.verifyAndProcess(Buffer.from('{}'), '0'.repeat(64)),
    ).rejects.toMatchObject({ status: 500 });
    expect(metrics.webhookInvalid).not.toHaveBeenCalled();
  });

  it('JSON con firma válida pero malformado no cuenta autenticación inválida', async () => {
    const raw = Buffer.from('{malformed');
    const signature = createHmac('sha256', config.HMAC_SECRET!)
      .update(raw)
      .digest('hex');
    await expect(
      service.verifyAndProcess(raw, signature),
    ).rejects.toMatchObject({ status: 400 });
    expect(metrics.webhookInvalid).not.toHaveBeenCalled();
  });
});
