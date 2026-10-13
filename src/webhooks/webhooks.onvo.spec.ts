import {
  BadGatewayException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PaymentProvider,
  PaymentStatus,
} from '../payments/entities/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { PaymentMetricsService } from '../observability/payment-metrics.service';
import { createWebhookReceiptMiddleware } from '../observability/webhook-receipt.middleware';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { ReceivedWebhook, WebhookLogService } from './webhook-log.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('../payments/dto/update-payment.dto', () => ({
  UpdatePaymentDto: class UpdatePaymentDto {},
}));

describe('POST /webhooks/onvo (HTTP)', () => {
  let app: INestApplication<App>;
  let webhookLog: WebhookLogService;
  let config: Record<string, string | undefined>;
  const secret = 'webhook_secret_abc123';
  const paymentId = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  const intentId = 'cl4de13uc457301lor2o0q9w1';
  const payment = {
    id: paymentId,
    status: PaymentStatus.PENDING,
    provider: PaymentProvider.ONVO,
    externalPaymentId: intentId,
  };
  const paymentsService = {
    findOnvoPayment: jest.fn(),
    confirmPayment: jest.fn(),
  };
  const onvoClient = { getPaymentIntent: jest.fn() };
  const metrics = {
    webhookReceived: jest.fn(),
    webhookInvalid: jest.fn(),
    recordWebhookDuration: jest.fn(),
  };

  function event(type: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      type,
      data: {
        id: intentId,
        status: 'succeeded',
        metadata: { paymentId },
        ...overrides,
      },
    });
  }

  // headerSecret = null: no se manda el header.
  function send(body: string, headerSecret: string | null = secret) {
    const req = request(app.getHttpServer())
      .post('/webhooks/onvo')
      .set('Content-Type', 'application/json');
    if (headerSecret !== null) {
      req.set('X-Webhook-Secret', headerSecret);
    }
    return req.send(body);
  }

  async function received() {
    const res = await request(app.getHttpServer())
      .get('/webhooks/recibidos')
      .expect(200);
    return res.body as ReceivedWebhook[];
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        WebhookLogService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: OnvoClient, useValue: onvoClient },
        { provide: PaymentMetricsService, useValue: metrics },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.use(createWebhookReceiptMiddleware(module.get(PaymentMetricsService)));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    webhookLog = module.get(WebhookLogService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config = { ONVO_WEBHOOK_SECRET: secret };
    webhookLog.setStoreDown(false);
    paymentsService.findOnvoPayment.mockResolvedValue(payment);
    paymentsService.confirmPayment.mockResolvedValue({
      applied: true,
      payment: { ...payment, status: PaymentStatus.APPROVED },
    });
    onvoClient.getPaymentIntent.mockResolvedValue({
      id: intentId,
      status: 'succeeded',
      metadata: { paymentId },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('autenticación', () => {
    it('sin X-Webhook-Secret responde 401 y no toca nada', async () => {
      await send(event('payment-intent.succeeded'), null).expect(401);
      expect(paymentsService.findOnvoPayment).not.toHaveBeenCalled();
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
      expect(metrics.webhookInvalid).toHaveBeenCalledWith(PaymentProvider.ONVO);
      expect(metrics.webhookReceived).toHaveBeenCalledWith(
        PaymentProvider.ONVO,
      );
      expect(metrics.recordWebhookDuration).toHaveBeenCalledTimes(1);
    });

    it('con un secreto distinto responde 401', async () => {
      await send(event('payment-intent.succeeded'), 'webhook_secret_falso')
        .expect(401)
        .expect((res) => {
          expect((res.body as { message: string }).message).toContain(
            'X-Webhook-Secret',
          );
        });
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
      expect(metrics.webhookInvalid).toHaveBeenCalledTimes(1);
    });

    it('un secreto más largo que el real también se rechaza', async () => {
      await send(event('payment-intent.succeeded'), `${secret}extra`).expect(
        401,
      );
    });

    it('si el servidor no tiene ONVO_WEBHOOK_SECRET responde 500, nunca acepta', async () => {
      config.ONVO_WEBHOOK_SECRET = undefined;
      await send(event('payment-intent.succeeded'), '').expect(500);
      await send(event('payment-intent.succeeded')).expect(500);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
      expect(metrics.webhookInvalid).not.toHaveBeenCalled();
    });

    it('el secreto recibido nunca queda en el registro de webhooks', async () => {
      await send(event('payment-intent.succeeded')).expect(200);
      await send(
        event('payment-intent.succeeded'),
        'webhook_secret_falso',
      ).expect(401);
      const log = await received();
      expect(JSON.stringify(log)).not.toContain(secret);
      expect(JSON.stringify(log)).not.toContain('webhook_secret_falso');
      expect(log[0]).toMatchObject({
        httpStatus: 401,
        outcome: 'INVALID_SIGNATURE',
        signatureValid: false,
        signature: null,
      });
    });
  });

  describe('eventos', () => {
    it('succeeded: verifica con ONVO y aprueba el pago', async () => {
      await send(event('payment-intent.succeeded'))
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ applied: true });
        });
      expect(paymentsService.findOnvoPayment).toHaveBeenCalledWith(
        intentId,
        paymentId,
      );
      expect(onvoClient.getPaymentIntent).toHaveBeenCalledWith(intentId);
      expect(paymentsService.confirmPayment).toHaveBeenCalledWith(
        paymentId,
        PaymentStatus.APPROVED,
        PaymentProvider.ONVO,
      );
      expect(metrics.webhookReceived).toHaveBeenCalledTimes(1);
      expect(metrics.webhookReceived).toHaveBeenCalledWith(
        PaymentProvider.ONVO,
      );
      expect(metrics.webhookInvalid).not.toHaveBeenCalled();
      expect(metrics.recordWebhookDuration).toHaveBeenCalledWith(
        PaymentProvider.ONVO,
        expect.any(Number),
      );
    });

    it('failed: ONVO devuelve el intent a requires_payment_method y el pago se rechaza', async () => {
      onvoClient.getPaymentIntent.mockResolvedValue({
        id: intentId,
        status: 'requires_payment_method',
        metadata: { paymentId },
      });
      await send(
        event('payment-intent.failed', { status: 'requires_payment_method' }),
      ).expect(200);
      expect(paymentsService.confirmPayment).toHaveBeenCalledWith(
        paymentId,
        PaymentStatus.REJECTED,
        PaymentProvider.ONVO,
      );
    });

    it('deferred: el pago sigue pendiente y no se llama a ONVO ni se confirma', async () => {
      await send(event('payment-intent.deferred', { status: 'processing' }))
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ applied: false });
        });
      expect(onvoClient.getPaymentIntent).not.toHaveBeenCalled();
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });

    it('un tipo de evento que no usamos se ignora con 200', async () => {
      await send(JSON.stringify({ type: 'refund.created', data: {} }))
        .expect(200)
        .expect((res) => {
          expect((res.body as { message: string }).message).toContain(
            'refund.created',
          );
        });
      expect(paymentsService.findOnvoPayment).not.toHaveBeenCalled();
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });

    it('un evento repetido responde 200 sin cambios', async () => {
      paymentsService.confirmPayment.mockResolvedValue({
        applied: false,
        payment: { ...payment, status: PaymentStatus.APPROVED },
      });
      await send(event('payment-intent.succeeded'))
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ applied: false });
        });
      const [entry] = await received();
      expect(entry).toMatchObject({
        httpStatus: 200,
        outcome: 'DUPLICATE',
        signatureValid: true,
        paymentId,
        status: 'succeeded',
      });
    });

    it('un pago desconocido responde 200 para que ONVO no reintente', async () => {
      paymentsService.findOnvoPayment.mockResolvedValue(undefined);
      await send(event('payment-intent.succeeded')).expect(200);
      expect(onvoClient.getPaymentIntent).not.toHaveBeenCalled();
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });
  });

  describe('verificación contra ONVO', () => {
    it('si el evento dice succeeded pero ONVO dice otra cosa, no se aprueba', async () => {
      onvoClient.getPaymentIntent.mockResolvedValue({
        id: intentId,
        status: 'requires_payment_method',
        metadata: { paymentId },
      });
      await send(event('payment-intent.succeeded')).expect(200);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });

    it('si el evento dice failed pero ONVO ya lo cobró, no se rechaza', async () => {
      await send(event('payment-intent.failed')).expect(200);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });

    it('si el intent pertenece a otro pago, se ignora', async () => {
      onvoClient.getPaymentIntent.mockResolvedValue({
        id: intentId,
        status: 'succeeded',
        metadata: { paymentId: '00000000-0000-4000-8000-000000000000' },
      });
      await send(event('payment-intent.succeeded')).expect(200);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });

    it('si no se puede consultar a ONVO, falla (no 2xx) y no cambia nada', async () => {
      onvoClient.getPaymentIntent.mockRejectedValue(
        new BadGatewayException('ONVO rechazó la solicitud (HTTP 401)'),
      );
      await send(event('payment-intent.succeeded')).expect(502);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
      expect(metrics.webhookInvalid).not.toHaveBeenCalled();
      expect(metrics.recordWebhookDuration).toHaveBeenCalledTimes(1);
    });

    it('con ONVO_VERIFY_EVENTS=false confía en el evento y no consulta a ONVO', async () => {
      config.ONVO_VERIFY_EVENTS = 'false';
      await send(event('payment-intent.succeeded')).expect(200);
      expect(onvoClient.getPaymentIntent).not.toHaveBeenCalled();
      expect(paymentsService.confirmPayment).toHaveBeenCalledWith(
        paymentId,
        PaymentStatus.APPROVED,
        PaymentProvider.ONVO,
      );
    });
  });

  describe('cuerpo inválido', () => {
    it.each([
      ['no es JSON', 'esto no es json'],
      ['no es un objeto', '[1,2,3]'],
      ['no trae type', JSON.stringify({ data: { id: intentId } })],
      [
        'el evento no trae data.id',
        JSON.stringify({ type: 'payment-intent.succeeded', data: {} }),
      ],
    ])('responde 400 si %s', async (_name, body) => {
      await send(body).expect(400);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    });
  });

  it('con la tienda caída (simulación de la demo) responde 503', async () => {
    webhookLog.setStoreDown(true);
    await send(event('payment-intent.succeeded')).expect(503);
    expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    expect(metrics.webhookReceived).toHaveBeenCalledTimes(1);
    expect(metrics.webhookInvalid).not.toHaveBeenCalled();
    expect(metrics.recordWebhookDuration).toHaveBeenCalledTimes(1);
  });

  it('un fallo de PostgreSQL no es un secreto de WebHook inválido', async () => {
    paymentsService.confirmPayment.mockRejectedValue(
      new Error('database unavailable'),
    );
    await send(event('payment-intent.succeeded')).expect(500);
    expect(metrics.webhookReceived).toHaveBeenCalledWith(PaymentProvider.ONVO);
    expect(metrics.webhookInvalid).not.toHaveBeenCalled();
    expect(metrics.recordWebhookDuration).toHaveBeenCalledTimes(1);
  });
});
