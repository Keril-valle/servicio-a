import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PaymentsController } from '../payments/payments.controller';
import {
  PaymentProvider,
  PaymentStatus,
} from '../payments/entities/payment.entity';
import { PaymentsService } from '../payments/payments.service';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { ReceivedWebhook, WebhookLogService } from './webhook-log.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('../payments/dto/update-payment.dto', () => ({
  UpdatePaymentDto: class UpdatePaymentDto {},
}));

describe('Webhook de pagos y consultas de pagos (HTTP)', () => {
  let app: INestApplication<App>;
  let webhookLog: WebhookLogService;
  const secret = 'test-hmac-secret';
  const paymentId = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  const payment = {
    id: paymentId,
    status: PaymentStatus.APPROVED,
    provider: PaymentProvider.FAKE,
  };
  const paymentsService = {
    confirmPayment: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
  };

  function sign(body: string) {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  async function receivedWebhooks() {
    const res = await request(app.getHttpServer())
      .get('/webhooks/recibidos')
      .expect(200);
    return res.body as ReceivedWebhook[];
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WebhooksController, PaymentsController],
      providers: [
        WebhooksService,
        WebhookLogService,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: OnvoClient, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    webhookLog = module.get(WebhookLogService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    webhookLog.setStoreDown(false);
    paymentsService.confirmPayment.mockResolvedValue({
      applied: true,
      payment,
    });
    paymentsService.findAll.mockResolvedValue([payment]);
    paymentsService.findOne.mockResolvedValue(payment);
  });

  afterAll(async () => {
    await app.close();
  });

  it('verifica los bytes originales con espacios y confirma el pago', async () => {
    const body = `{ "event": "payment.updated", "paymentId": "${paymentId}", "status": "APPROVED" }`;
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(200)
      .expect({
        message: 'Webhook recibido y verificado',
        applied: true,
        payment,
      });
    expect(paymentsService.confirmPayment).toHaveBeenCalledWith(
      paymentId,
      PaymentStatus.APPROVED,
      PaymentProvider.FAKE,
    );
  });

  it('acepta DEFERRED y el identificador externo del proveedor', async () => {
    const body = JSON.stringify({
      event: 'payment.updated',
      paymentId,
      externalPaymentId: 'ext-123',
      status: 'DEFERRED',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(200);
    expect(paymentsService.confirmPayment).toHaveBeenCalledWith(
      paymentId,
      PaymentStatus.DEFERRED,
      PaymentProvider.FAKE,
    );
  });

  it('responde 200 a un webhook repetido sin aplicar cambios', async () => {
    paymentsService.confirmPayment.mockResolvedValue({
      applied: false,
      payment,
    });
    const body = JSON.stringify({
      event: 'payment.updated',
      paymentId,
      status: 'APPROVED',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(200)
      .expect({
        message: 'Webhook ya procesado; no se aplicaron cambios',
        applied: false,
        payment,
      });
  });

  it.each([undefined, 'malformada', '0'.repeat(64)])(
    'rechaza firma ausente o inválida (%s)',
    async (signature) => {
      const req = request(app.getHttpServer())
        .post('/webhooks/payments')
        .set('Content-Type', 'application/json');
      if (signature) req.set('X-Signature', signature);
      await req
        .send({ event: 'payment.updated', paymentId, status: 'APPROVED' })
        .expect(401);
      expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
    },
  );

  it('rechaza un payload alterado después de firmar', async () => {
    const body = JSON.stringify({
      event: 'payment.updated',
      paymentId,
      status: 'APPROVED',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('X-Signature', sign(body))
      .send({ event: 'payment.updated', paymentId, status: 'REJECTED' })
      .expect(401);
    expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
  });

  it.each([
    { event: 'payment.updated', paymentId, status: 'PENDING' },
    { event: 'payment.updated', paymentId, status: 'APPROVED', amount: 1 },
    { event: 'payment.updated', paymentId: 'no-es-uuid', status: 'APPROVED' },
    { event: 'pedido.creado', paymentId, status: 'APPROVED' },
    { paymentId, status: 'APPROVED' },
  ])('valida el payload después de verificar la firma', async (payload) => {
    const body = JSON.stringify(payload);
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(400);
    expect(paymentsService.confirmPayment).not.toHaveBeenCalled();
  });

  it('registra cada webhook recibido, también los rechazados', async () => {
    const body = JSON.stringify({
      event: 'payment.updated',
      paymentId,
      status: 'APPROVED',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 'firma-falsa')
      .send(body)
      .expect(401);

    const received = await receivedWebhooks();
    expect(received.slice(0, 2)).toMatchObject([
      {
        httpStatus: 401,
        outcome: 'INVALID_SIGNATURE',
        signatureValid: false,
        signature: 'firma-falsa',
        paymentId,
        status: 'APPROVED',
      },
      { httpStatus: 200, outcome: 'APPLIED', signatureValid: true, body },
    ]);
  });

  it('con la tienda caída responde 503 sin procesar el webhook', async () => {
    await request(app.getHttpServer())
      .put('/webhooks/simulacion')
      .send({ storeDown: true })
      .expect(200)
      .expect({ storeDown: true });

    const body = JSON.stringify({
      event: 'payment.updated',
      paymentId,
      status: 'APPROVED',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(503);
    expect(paymentsService.confirmPayment).not.toHaveBeenCalled();

    const [latest] = await receivedWebhooks();
    expect(latest).toMatchObject({
      httpStatus: 503,
      outcome: 'STORE_DOWN',
      signatureValid: null,
    });
  });

  it('valida el interruptor de la simulación', async () => {
    await request(app.getHttpServer())
      .put('/webhooks/simulacion')
      .send({ storeDown: 'si' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/webhooks/simulacion')
      .expect(200)
      .expect({ storeDown: false });
  });

  it('GET /payments lista pagos', async () => {
    await request(app.getHttpServer())
      .get('/payments')
      .expect(200)
      .expect([payment]);
  });

  it('GET /payments/:id consulta un pago', async () => {
    await request(app.getHttpServer())
      .get(`/payments/${paymentId}`)
      .expect(200)
      .expect(payment);
  });

  it('devuelve 404 si el pago no existe', async () => {
    paymentsService.findOne.mockRejectedValue(new NotFoundException());
    await request(app.getHttpServer())
      .get(`/payments/${paymentId}`)
      .expect(404);
  });

  it('rechaza identificadores inválidos antes de consultar PostgreSQL', async () => {
    await request(app.getHttpServer()).get('/payments/no-es-uuid').expect(400);
    expect(paymentsService.findOne).not.toHaveBeenCalled();
  });
});
