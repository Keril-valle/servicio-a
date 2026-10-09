import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { of, throwError } from 'rxjs';
import { PaymentProvider, PaymentStatus } from './entities/payment.entity';
import { PaymentsService } from './payments.service';

jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

describe('PaymentsService', () => {
  const id = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  const row = {
    id,
    amount: 15000,
    status: PaymentStatus.PENDING,
    provider: PaymentProvider.FAKE,
    externalPaymentId: null,
    createdAt: new Date('2026-10-08T00:00:00Z'),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  };
  let query: jest.Mock;
  let post: jest.Mock;
  let service: PaymentsService;

  beforeEach(() => {
    query = jest.fn();
    post = jest.fn();
    (Pool as unknown as jest.Mock).mockImplementation(() => ({
      query,
      end: jest.fn(),
    }));
    service = new PaymentsService(
      {
        get: (name: string) =>
          name === 'DATABASE_URL' ? 'postgresql://test' : undefined,
      } as ConfigService,
      { post } as unknown as HttpService,
    );
  });

  it('la respuesta HTTP del proveedor no aprueba el pago', async () => {
    query.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(of({ data: { status: 'APPROVED' } }));
    const payment = await service.create({
      amount: 15000,
      provider: PaymentProvider.FAKE,
    });
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(post).toHaveBeenCalledWith(
      'http://service-b:3001/payments',
      { paymentId: id, amount: 15000 },
      { timeout: 5000 },
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), [
      expect.any(String),
      15000,
      PaymentStatus.PENDING,
      PaymentProvider.FAKE,
      null,
    ]);
  });

  it('una falla del proveedor no cambia el estado persistido', async () => {
    query.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(throwError(() => new Error('offline')));
    await expect(
      service.create({ amount: 15000, provider: PaymentProvider.FAKE }),
    ).rejects.toMatchObject({ status: 503 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([PaymentStatus.APPROVED, PaymentStatus.REJECTED])(
    'confirma PENDING → %s con condición atómica',
    async (status) => {
      query.mockResolvedValue({ rows: [{ ...row, status }] });
      await expect(
        service.confirmFakePayment(id, status),
      ).resolves.toMatchObject({ status });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('AND provider = $3 AND status = $4'),
        [id, status, PaymentProvider.FAKE, PaymentStatus.PENDING],
      );
    },
  );

  it('acepta duplicados sin volver a cambiar el pago', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ ...row, status: PaymentStatus.APPROVED }],
    });
    await expect(
      service.confirmFakePayment(id, PaymentStatus.APPROVED),
    ).resolves.toMatchObject({ status: PaymentStatus.APPROVED });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...row, status: PaymentStatus.REJECTED },
    { ...row, provider: PaymentProvider.ONVO },
  ])(
    'rechaza estado final contrario o proveedor incorrecto',
    async (payment) => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [payment] });
      await expect(
        service.confirmFakePayment(id, PaymentStatus.APPROVED),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('devuelve 404 para una confirmación de pago inexistente', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(
      service.confirmFakePayment(id, PaymentStatus.APPROVED),
    ).rejects.toMatchObject({ status: 404 });
  });
});
