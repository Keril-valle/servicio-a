import { Logger } from '@nestjs/common';
import { metrics, ValueType } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import {
  PaymentProvider,
  PaymentStatus,
} from '../payments/entities/payment.entity';
import { PaymentMetricsService } from './payment-metrics.service';

describe('PaymentMetricsService', () => {
  let counters: Record<string, jest.Mock>;
  let record: jest.Mock;
  let meter: { createCounter: jest.Mock; createHistogram: jest.Mock };
  let service: PaymentMetricsService;
  let getMeter: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    counters = {};
    record = jest.fn();
    meter = {
      createCounter: jest.fn((name: string) => {
        counters[name] = jest.fn();
        return { add: counters[name] };
      }),
      createHistogram: jest.fn(() => ({ record })),
    };
    getMeter = jest
      .spyOn(metrics, 'getMeter')
      .mockReturnValue(meter as unknown as Meter);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new PaymentMetricsService();
  });

  afterEach(() => jest.restoreAllMocks());

  it('obtiene el meter global y usa nombres base sin sufijos ni unidades de contador', () => {
    expect(getMeter).toHaveBeenCalledWith(
      'servicio-a.payment-business',
      '1.0.0',
    );
    expect(
      meter.createCounter.mock.calls.map((call: [string]) => call[0]),
    ).toEqual([
      'payments_created',
      'payments_approved',
      'payments_rejected',
      'webhooks_received',
      'webhooks_invalid',
    ]);
    expect(meter.createCounter).toHaveBeenCalledWith('payments_created', {
      description: expect.any(String) as string,
      valueType: ValueType.INT,
    });
    expect(meter.createHistogram).toHaveBeenCalledWith(
      'webhook_processing_duration',
      {
        description: expect.any(String) as string,
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
          ],
        },
      },
    );
  });

  it.each([PaymentProvider.FAKE, PaymentProvider.ONVO])(
    'registra todos los instrumentos solo con el atributo provider=%s',
    (provider) => {
      service.paymentCreated(provider);
      service.paymentConfirmed(provider, PaymentStatus.APPROVED);
      service.paymentConfirmed(provider, PaymentStatus.REJECTED);
      service.webhookReceived(provider);
      service.webhookInvalid(provider);
      service.recordWebhookDuration(provider, 0.125);
      for (const add of Object.values(counters)) {
        expect(add).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledWith(1, { provider });
      }
      expect(record).toHaveBeenCalledWith(0.125, { provider });
    },
  );

  it.each([PaymentStatus.PENDING, PaymentStatus.DEFERRED])(
    'no cuenta %s como aprobado o rechazado',
    (status) => {
      service.paymentConfirmed(PaymentProvider.FAKE, status);
      expect(counters.payments_approved).not.toHaveBeenCalled();
      expect(counters.payments_rejected).not.toHaveBeenCalled();
    },
  );

  it('fallos al obtener el meter no impiden construir ni utilizar el servicio', () => {
    getMeter.mockImplementation(() => {
      throw new Error('private exporter configuration');
    });
    const unavailable = new PaymentMetricsService();
    expect(() => {
      unavailable.paymentCreated(PaymentProvider.FAKE);
      unavailable.paymentConfirmed(
        PaymentProvider.ONVO,
        PaymentStatus.APPROVED,
      );
      unavailable.webhookReceived(PaymentProvider.FAKE);
      unavailable.webhookInvalid(PaymentProvider.ONVO);
      unavailable.recordWebhookDuration(PaymentProvider.FAKE, 1);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('private'));
  });

  it('fallos al construir instrumentos tampoco interrumpen el arranque', () => {
    meter.createCounter.mockImplementation(() => {
      throw new Error('counter unavailable');
    });
    meter.createHistogram.mockImplementation(() => {
      throw new Error('histogram unavailable');
    });
    const unavailable = new PaymentMetricsService();
    expect(() =>
      unavailable.paymentCreated(PaymentProvider.ONVO),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('absorbe fallos de registro sin filtrar secretos y limita el aviso a una vez', () => {
    for (const add of Object.values(counters)) {
      add.mockImplementation(() => {
        throw new Error('private credential');
      });
    }
    record.mockImplementation(() => {
      throw new Error('private credential');
    });
    expect(() => {
      service.paymentCreated(PaymentProvider.FAKE);
      service.paymentConfirmed(PaymentProvider.FAKE, PaymentStatus.APPROVED);
      service.paymentConfirmed(PaymentProvider.ONVO, PaymentStatus.REJECTED);
      service.webhookReceived(PaymentProvider.ONVO);
      service.webhookInvalid(PaymentProvider.ONVO);
      service.recordWebhookDuration(PaymentProvider.ONVO, 1);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('private'));
  });
});
