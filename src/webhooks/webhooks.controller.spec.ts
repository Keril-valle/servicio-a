import { INestApplication, NotFoundException } from '@nestjs/common';
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
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('../payments/dto/update-payment.dto', () => ({
  UpdatePaymentDto: class UpdatePaymentDto {},
}));

describe('Webhooks FAKE y consultas de pagos (HTTP)', () => {
  let app: INestApplication<App>;
  const secret = 'test-hmac-secret';
  const paymentId = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  const payment = {
    id: paymentId,
    status: PaymentStatus.APPROVED,
    provider: PaymentProvider.FAKE,
  };
  const paymentsService = {
    confirmFakePayment: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
  };

  function sign(body: string) {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WebhooksController, PaymentsController],
      providers: [
        WebhooksService,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paymentsService.confirmFakePayment.mockResolvedValue(payment);
    paymentsService.findAll.mockResolvedValue([payment]);
    paymentsService.findOne.mockResolvedValue(payment);
  });

  afterAll(async () => {
    await app.close();
  });

  it('verifica los bytes originales con espacios y confirma el pago', async () => {
    const body = `{ "paymentId": "${paymentId}", "status": "APPROVED" }`;
    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(200)
      .expect({ message: 'Webhook recibido y verificado', payment });
    expect(paymentsService.confirmFakePayment).toHaveBeenCalledWith(
      paymentId,
      PaymentStatus.APPROVED,
    );
  });

  it.each([undefined, 'malformada', '0'.repeat(64)])(
    'rechaza firma ausente o inválida (%s)',
    async (signature) => {
      const req = request(app.getHttpServer())
        .post('/webhooks/fake')
        .set('Content-Type', 'application/json');
      if (signature) req.set('X-Signature', signature);
      await req.send({ paymentId, status: 'APPROVED' }).expect(401);
      expect(paymentsService.confirmFakePayment).not.toHaveBeenCalled();
    },
  );

  it('rechaza un payload alterado después de firmar', async () => {
    const body = JSON.stringify({ paymentId, status: 'APPROVED' });
    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('X-Signature', sign(body))
      .send({ paymentId, status: 'REJECTED' })
      .expect(401);
    expect(paymentsService.confirmFakePayment).not.toHaveBeenCalled();
  });

  it.each([
    { paymentId, status: 'PENDING' },
    { paymentId, status: 'APPROVED', amount: 1 },
    { paymentId: 'no-es-uuid', status: 'APPROVED' },
  ])('valida el payload después de verificar la firma', async (payload) => {
    const body = JSON.stringify(payload);
    await request(app.getHttpServer())
      .post('/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(body))
      .send(body)
      .expect(400);
    expect(paymentsService.confirmFakePayment).not.toHaveBeenCalled();
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
