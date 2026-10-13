import {
  BadGatewayException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { PaymentMetricsService } from '../observability/payment-metrics.service';
import { metrics as otelMetrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
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
  let onvoClient: {
    assertConfigured: jest.Mock;
    getPublishableKey: jest.Mock;
    createPaymentIntent: jest.Mock;
  };
  let service: PaymentsService;
  let metrics: { paymentCreated: jest.Mock; paymentConfirmed: jest.Mock };

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
    onvoClient = {
      assertConfigured: jest.fn(),
      getPublishableKey: jest
        .fn()
        .mockReturnValue('onvo_test_publishable_key_x'),
      createPaymentIntent: jest.fn(),
    };
    metrics = { paymentCreated: jest.fn(), paymentConfirmed: jest.fn() };
    service = new PaymentsService(
      { query, transaction } as unknown as DatabaseService,
      pedidosService as unknown as PedidosService,
      { get: () => undefined } as unknown as ConfigService,
      { post } as unknown as HttpService,
      onvoClient as unknown as OnvoClient,
      metrics as unknown as PaymentMetricsService,
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
    expect(metrics.paymentCreated).toHaveBeenCalledTimes(1);
    expect(metrics.paymentCreated).toHaveBeenCalledWith(PaymentProvider.FAKE);
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
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
    // El pago ya quedó creado, aunque falle el envío al proveedor.
    expect(metrics.paymentCreated).toHaveBeenCalledWith(PaymentProvider.FAKE);
  });

  describe('proveedor ONVO', () => {
    const intentId = 'cl4de13uc457301lor2o0q9w1';
    const onvoRow = { ...row, provider: PaymentProvider.ONVO };

    it('crea el pago, el Payment Intent y devuelve lo que el frontend necesita para el SDK', async () => {
      clientQuery.mockResolvedValue({ rows: [onvoRow] });
      query
        .mockResolvedValueOnce({ rows: [] }) // UPDATE external_payment_id
        .mockResolvedValueOnce({
          rows: [{ ...onvoRow, externalPaymentId: intentId }],
        }); // findOne
      onvoClient.createPaymentIntent.mockResolvedValue({
        id: intentId,
        status: 'requires_payment_method',
      });

      const payment = await service.create({
        amount: 15000,
        provider: PaymentProvider.ONVO,
      });

      expect(onvoClient.createPaymentIntent).toHaveBeenCalledWith({
        paymentId: id,
        amount: 15000,
        description: 'Pago Producto A',
      });
      expect(clientQuery).toHaveBeenCalledWith(expect.any(String), [
        expect.any(String),
        orderId,
        15000,
        PaymentStatus.PENDING,
        PaymentProvider.ONVO,
        null,
      ]);
      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('external_payment_id = $2'),
        [id, intentId],
      );
      expect(payment).toMatchObject({
        id,
        status: PaymentStatus.PENDING,
        provider: PaymentProvider.ONVO,
        externalPaymentId: intentId,
        onvo: {
          paymentIntentId: intentId,
          publishableKey: 'onvo_test_publishable_key_x',
        },
      });
      expect(post).not.toHaveBeenCalled(); // no se usa el Fake Provider
      expect(metrics.paymentCreated).toHaveBeenCalledWith(PaymentProvider.ONVO);
      expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
    });

    it('la descripción usa el producto enviado', async () => {
      clientQuery.mockResolvedValue({ rows: [onvoRow] });
      query.mockResolvedValue({ rows: [onvoRow] });
      onvoClient.createPaymentIntent.mockResolvedValue({
        id: intentId,
        status: 'requires_payment_method',
      });

      await service.create({
        product: 'Camiseta',
        amount: 15000,
        provider: PaymentProvider.ONVO,
      });

      expect(onvoClient.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Pago Camiseta' }),
      );
    });

    it('sin claves de ONVO falla antes de crear pedido o pago', async () => {
      onvoClient.assertConfigured.mockImplementation(() => {
        throw new InternalServerErrorException(
          'Falta configurar ONVO_PUBLISHABLE_KEY',
        );
      });

      await expect(
        service.create({ amount: 15000, provider: PaymentProvider.ONVO }),
      ).rejects.toMatchObject({ status: 500 });
      expect(transaction).not.toHaveBeenCalled();
      expect(onvoClient.createPaymentIntent).not.toHaveBeenCalled();
      expect(metrics.paymentCreated).not.toHaveBeenCalled();
    });

    it('si ONVO falla, el pago queda REJECTED (no PENDING para siempre) y se propaga el error', async () => {
      // 1.ª consulta: INSERT del pago. 2.ª: UPDATE a REJECTED dentro de confirmPayment.
      clientQuery
        .mockResolvedValueOnce({ rows: [onvoRow] })
        .mockResolvedValueOnce({
          rows: [{ ...onvoRow, status: PaymentStatus.REJECTED }],
        });
      onvoClient.createPaymentIntent.mockRejectedValue(
        new BadGatewayException('ONVO rechazó la solicitud (HTTP 400)'),
      );

      await expect(
        service.create({ amount: 15000, provider: PaymentProvider.ONVO }),
      ).rejects.toMatchObject({ status: 502 });

      expect(clientQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('status = ANY($4::payment_status[])'),
        [
          id,
          PaymentStatus.REJECTED,
          PaymentProvider.ONVO,
          [PaymentStatus.PENDING, PaymentStatus.DEFERRED],
        ],
      );
      expect(pedidosService.applyPaymentStatus).toHaveBeenCalledWith(
        { query: clientQuery },
        orderId,
        PaymentStatus.REJECTED,
      );
      expect(query).not.toHaveBeenCalled(); // nunca se guardó un externalPaymentId
      expect(metrics.paymentConfirmed).toHaveBeenCalledWith(
        PaymentProvider.ONVO,
        PaymentStatus.REJECTED,
      );
    });

    it('si además falla marcarlo como rechazado, igual se propaga el error original de ONVO', async () => {
      clientQuery
        .mockResolvedValueOnce({ rows: [onvoRow] })
        .mockRejectedValueOnce(new Error('db caída'));
      onvoClient.createPaymentIntent.mockRejectedValue(
        new ServiceUnavailableException('No se pudo comunicar con ONVO'),
      );

      await expect(
        service.create({ amount: 15000, provider: PaymentProvider.ONVO }),
      ).rejects.toMatchObject({ status: 503 });
      expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
    });
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
      expect(metrics.paymentConfirmed).toHaveBeenCalledTimes(1);
      expect(metrics.paymentConfirmed).toHaveBeenCalledWith(
        PaymentProvider.FAKE,
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
      expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
    },
  );

  describe('findOnvoPayment', () => {
    const intentId = 'cl4de13uc457301lor2o0q9w1';
    const onvoRow = {
      ...row,
      provider: PaymentProvider.ONVO,
      externalPaymentId: intentId,
    };

    it('encuentra el pago por el id del Payment Intent, solo entre pagos ONVO', async () => {
      query.mockResolvedValueOnce({ rows: [onvoRow] });

      const found = await service.findOnvoPayment(intentId, id);

      expect(found?.id).toBe(id);
      expect(found?.externalPaymentId).toBe(intentId);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('external_payment_id = $1');
      expect(sql).toContain('provider = $2');
      expect(params).toEqual([intentId, PaymentProvider.ONVO]);
    });

    it('si el intent aún no estaba guardado, usa metadata.paymentId y lo completa', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [onvoRow] });

      const found = await service.findOnvoPayment(intentId, id);

      expect(found?.externalPaymentId).toBe(intentId);
      const [sql, params] = query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('UPDATE payments SET external_payment_id');
      expect(sql).toContain('external_payment_id IS NULL');
      expect(params).toEqual([id, intentId, PaymentProvider.ONVO]);
    });

    it('sin coincidencia por id y con metadata ausente, no encuentra nada', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.findOnvoPayment(intentId, undefined),
      ).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('ignora un metadata.paymentId que no es UUID sin tocar la base', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.findOnvoPayment(intentId, "1' OR '1'='1"),
      ).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('no pisa el id externo de un pago que ya tiene otro intent', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.findOnvoPayment(intentId, id),
      ).resolves.toBeUndefined();
    });
  });

  it('rechaza un webhook para un pago de otro proveedor', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    query.mockResolvedValue({
      rows: [{ ...row, provider: PaymentProvider.ONVO }],
    });
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toMatchObject({ status: 409 });
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
  });

  it('devuelve 404 para una confirmación de pago inexistente', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    query.mockResolvedValue({ rows: [] });
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toMatchObject({ status: 404 });
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
  });

  it('un INSERT fallido no cuenta un pago creado', async () => {
    clientQuery.mockRejectedValue(new Error('insert failed'));
    await expect(
      service.create({ amount: 15000, provider: PaymentProvider.FAKE }),
    ).rejects.toThrow('insert failed');
    expect(metrics.paymentCreated).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('espera el COMMIT antes de contar una creación', async () => {
    clientQuery.mockResolvedValue({ rows: [row] });
    query.mockResolvedValue({ rows: [row] });
    post.mockReturnValue(of({ data: {} }));
    transaction.mockImplementation(
      async (work: (client: unknown) => Promise<unknown>) => {
        const payment = await work({ query: clientQuery });
        expect(metrics.paymentCreated).not.toHaveBeenCalled();
        return payment; // representa un COMMIT exitoso
      },
    );
    await service.create({ amount: 15000, provider: PaymentProvider.FAKE });
    expect(metrics.paymentCreated).toHaveBeenCalledTimes(1);
  });

  it('un COMMIT fallido tras el INSERT no cuenta la creación', async () => {
    clientQuery.mockResolvedValue({ rows: [row] });
    transaction.mockImplementation(
      async (work: (client: unknown) => Promise<unknown>) => {
        await work({ query: clientQuery });
        throw new Error('commit failed');
      },
    );
    await expect(
      service.create({ amount: 15000, provider: PaymentProvider.FAKE }),
    ).rejects.toThrow('commit failed');
    expect(metrics.paymentCreated).not.toHaveBeenCalled();
  });

  it.each([PaymentStatus.APPROVED, PaymentStatus.REJECTED])(
    'registra la transición %s con proveedor ONVO',
    async (status) => {
      clientQuery.mockResolvedValue({
        rows: [{ ...row, status, provider: PaymentProvider.ONVO }],
      });
      await service.confirmPayment(id, status, PaymentProvider.ONVO);
      expect(metrics.paymentConfirmed).toHaveBeenCalledTimes(1);
      expect(metrics.paymentConfirmed).toHaveBeenCalledWith(
        PaymentProvider.ONVO,
        status,
      );
    },
  );

  it('un UPDATE fallido no cuenta una confirmación', async () => {
    clientQuery.mockRejectedValue(new Error('update failed'));
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toThrow('update failed');
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
  });

  it('si falla actualizar el pedido, no cuenta la transición revertida', async () => {
    clientQuery.mockResolvedValue({
      rows: [{ ...row, status: PaymentStatus.APPROVED }],
    });
    pedidosService.applyPaymentStatus.mockRejectedValue(
      new Error('order update failed'),
    );
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toThrow('order update failed');
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
  });

  it('un COMMIT fallido tras el UPDATE no cuenta la confirmación', async () => {
    clientQuery.mockResolvedValue({
      rows: [{ ...row, status: PaymentStatus.APPROVED }],
    });
    transaction.mockImplementation(
      async (work: (client: unknown) => Promise<unknown>) => {
        await work({ query: clientQuery });
        expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
        throw new Error('commit failed');
      },
    );
    await expect(
      service.confirmPayment(id, PaymentStatus.APPROVED, PaymentProvider.FAKE),
    ).rejects.toThrow('commit failed');
    expect(metrics.paymentConfirmed).not.toHaveBeenCalled();
  });

  it.each([PaymentStatus.APPROVED, PaymentStatus.REJECTED])(
    'dos confirmaciones %s del mismo pago solo cuentan la primera',
    async (status) => {
      const approved = { ...row, status };
      clientQuery
        .mockResolvedValueOnce({ rows: [approved] })
        .mockResolvedValueOnce({ rows: [] });
      query.mockResolvedValue({ rows: [approved] });
      await service.confirmPayment(id, status, PaymentProvider.FAKE);
      await service.confirmPayment(id, status, PaymentProvider.FAKE);
      expect(metrics.paymentConfirmed).toHaveBeenCalledTimes(1);
    },
  );

  it('crea y confirma pagos aunque el instrumento de observabilidad arroje errores', async () => {
    const brokenMeter = {
      createCounter: () => ({
        add: () => {
          throw new Error('telemetry unavailable');
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error('telemetry unavailable');
        },
      }),
    };
    const spy = jest
      .spyOn(otelMetrics, 'getMeter')
      .mockReturnValue(brokenMeter as unknown as Meter);
    try {
      const resilient = new PaymentsService(
        { query, transaction } as unknown as DatabaseService,
        pedidosService as unknown as PedidosService,
        { get: () => undefined } as unknown as ConfigService,
        { post } as unknown as HttpService,
        onvoClient as unknown as OnvoClient,
        new PaymentMetricsService(),
      );
      clientQuery.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({
        rows: [{ ...row, status: PaymentStatus.APPROVED }],
      });
      query.mockResolvedValue({ rows: [row] });
      post.mockReturnValue(of({ data: {} }));
      await expect(
        resilient.create({ amount: 15000, provider: PaymentProvider.FAKE }),
      ).resolves.toMatchObject({ id });
      await expect(
        resilient.confirmPayment(
          id,
          PaymentStatus.APPROVED,
          PaymentProvider.FAKE,
        ),
      ).resolves.toMatchObject({ applied: true });
    } finally {
      spy.mockRestore();
    }
  });
});
