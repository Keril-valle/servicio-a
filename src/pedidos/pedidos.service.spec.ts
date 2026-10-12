import { DatabaseService } from '../database/database.service';
import { PaymentStatus } from '../payments/entities/payment.entity';
import { OrderStatus } from './entities/pedido.entity';
import { PedidosService } from './pedidos.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

describe('PedidosService', () => {
  const orderId = '3f6c1a52-4b8e-4f3a-9d2e-7c1b5a9e0f44';
  let query: jest.Mock;
  let service: PedidosService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    service = new PedidosService({} as DatabaseService);
  });

  it.each([
    [PaymentStatus.APPROVED, OrderStatus.PAID],
    [PaymentStatus.REJECTED, OrderStatus.PAYMENT_REJECTED],
  ])(
    'el pago %s cierra el pedido como %s si sigue pendiente',
    async (paymentStatus, orderStatus) => {
      await service.applyPaymentStatus({ query }, orderId, paymentStatus);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND status = $3'),
        [orderId, orderStatus, OrderStatus.PENDING_PAYMENT],
      );
    },
  );

  it('un pago DEFERRED deja el pedido pendiente', async () => {
    await service.applyPaymentStatus(
      { query },
      orderId,
      PaymentStatus.DEFERRED,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
