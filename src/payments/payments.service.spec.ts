import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { PaymentProvider, PaymentStatus } from './entities/payment.entity';
import { PaymentsService } from './payments.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

describe('PaymentsService', () => {
  const id = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  const orderId = '3f6c1a52-4b8e-4f3a-9d2e-7c1b5a9e0f44';
  const row = {
    id,
    orderId,
    amount: 15000,
    status: PaymentStatus.PENDING,
    provider: PaymentProvider.FAKE,
    externalPaymentId: null,
    createdAt: new Date('2026-10-08T00:00:00Z'),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  };
  let query: jest.Mock;
  let clientQuery: jest.Mock;
  let transaction: jest.Mock;
  let post: jest.Mock;
  let pedidosService: { create: jest.Mock; applyPaymentStatus: jest.Mock };
  let service: PaymentsService;

  beforeEach(() => {
    query = jest.fn();
    clientQuery = jest.fn();
    transaction = jest.fn((work: (client: unknown) => Promise<unknown>) =>
      work({ query: clientQuery }),
    );
    post = jest.fn();
    pedidosService = {
      create: jest.fn().mockResolvedValue({ id: orderId }),
      applyPaymentStatus: jest.fn(),
    };
    service = new PaymentsService(
      { query, transaction } as unknown as DatabaseService,
      pedidosService as unknown as PedidosService,
      { get: () => undefined } as unknown as ConfigService,
      { post } as unknown as HttpService,
    );
  });

  it('crea el pedido y el pago juntos; la respuesta del proveedor no aprueba el pago', async () => {
    clientQuery.mockResolvedValue({ rows: [row] });
    query.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(of({ data: { status: 'APPROVED' } }));

    const payment = await service.create({
      amount: 15000,
      provider: PaymentProvider.FAKE,
    });

    expect(payment).toMatchObject({ status: PaymentStatus.PENDING, orderId });
    expect(pedidosService.create).toHaveBeenCalledWith(
      { query: clientQuery },
      { product: 'Producto A', amount: 15000 },
    );
    expect(clientQuery).toHaveBeenCalledWith(expect.any(String), [
      expect.any(String),
      orderId,
      15000,
      PaymentStatus.PENDING,
      PaymentProvider.FAKE,
      null,
    ]);
    expect(post).toHaveBeenCalledWith(
      'http://service-b:3001/payments',
      { paymentId: id, amount: 15000 },
      { timeout: 5000 },
    );
  });

  it('usa el producto enviado por el cliente', async () => {
    clientQuery.mockResolvedValue({ rows: [row] });
    query.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(of({ data: {} }));

    await service.create({
      product: 'Camiseta',
      amount: 15000,
      provider: PaymentProvider.FAKE,
    });

    expect(pedidosService.create).toHaveBeenCalledWith(expect.anything(), {
      product: 'Camiseta',
      amount: 15000,
    });
  });

  it('una falla del proveedor no cambia el estado persistido', async () => {
    clientQuery.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(throwError(() => new Error('offline')));
    await expect(
      service.create({ amount: 15000, provider: PaymentProvider.FAKE }),
    ).rejects.toMatchObject({ status: 503 });
    expect(query).not.toHaveBeenCalled();
  });

  it('ONVO todavía no está integrado y no crea registros', async () => {
    await expect(
      service.create({ amount: 15000, provider: PaymentProvider.ONVO }),
    ).rejects.toMatchObject({ status: 501 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    [PaymentStatus.APPROVED, [PaymentStatus.PENDING, PaymentStatus.DEFERRED]],
    [PaymentStatus.REJECTED, [PaymentStatus.PENDING, PaymentStatus.DEFERRED]],
    [PaymentStatus.DEFERRED, [PaymentStatus.PENDING]],
  ])(
    'aplica %s con condición atómica y actualiza el pedido',
    async (status, allowedPrevious) => {
      clientQuery.mockResolvedValue({ rows: [{ ...row, status }] });

      await expect(
        service.confirmPayment(id, status, PaymentProvider.FAKE),
      ).resolves.toMatchObject({ applied: true, payment: { status } });

      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining('status = ANY($4::payment_status[])'),
        [id, status, PaymentProvider.FAKE, allowedPrevious],
      );
      expect(pedidosService.applyPaymentStatus).toHaveBeenCalledWith(
        { query: clientQuery },
        orderId,
        status,
      );
    },
  );

  it.each([
    [PaymentStatus.APPROVED, PaymentStatus.APPROVED],
    [PaymentStatus.DEFERRED, PaymentStatus.APPROVED],
    [PaymentStatus.APPROVED, PaymentStatus.REJECTED],
  ])(
    'acepta %s cuando el pago ya está en %s sin volver a cambiarlo',
    async (incoming, current) => {
      clientQuery.mockResolvedValue({ rows: [] });
      query.mockResolvedValue({ rows: [{ ...row, status: current }] });

      await expect(
        service.confirmPayment(id, incoming, PaymentProvider.FAKE),
      ).resolves.toMatchObject({
        applied: false,
        payment: { status: current },
      });
      expect(pedidosService.applyPaymentStatus).not.toHaveBeenCalled();
    },
  );

  it('rechaza un webhook para un pago de otro proveedor', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    query.mockResolvedValue({
      rows: [{ ...row, provider: PaymentProvider.ONVO }],
    });
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('devuelve 404 para una confirmación de pago inexistente', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    query.mockResolvedValue({ rows: [] });
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toMatchObject({ status: 404 });
  });
});
