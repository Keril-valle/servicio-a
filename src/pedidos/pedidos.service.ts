import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService, Queryable } from '../database/database.service';
import { PaymentStatus } from '../payments/entities/payment.entity';
import { OrderStatus, Pedido } from './entities/pedido.entity';

interface OrderRow extends QueryResultRow {
  id: string;
  product: string;
  amount: number;
  status: OrderStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

const ORDER_COLUMNS = `id, product, amount::float8 AS amount, status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const ORDER_STATUS_BY_PAYMENT: Partial<Record<PaymentStatus, OrderStatus>> = {
  [PaymentStatus.APPROVED]: OrderStatus.PAID,
  [PaymentStatus.REJECTED]: OrderStatus.PAYMENT_REJECTED,
};

@Injectable()
export class PedidosService {
  constructor(private readonly database: DatabaseService) {}

  async create(
    db: Queryable,
    order: { product: string; amount: number },
  ): Promise<Pedido> {
    const { rows } = await db.query<OrderRow>(
      `INSERT INTO orders (product, amount, status)
       VALUES ($1, $2, $3)
       RETURNING ${ORDER_COLUMNS}`,
      [order.product, order.amount, OrderStatus.PENDING_PAYMENT],
    );
    return this.toPedido(rows[0]);
  }

  async findAll(): Promise<Pedido[]> {
    const { rows } = await this.database.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.toPedido(row));
  }

  async findOne(id: string): Promise<Pedido> {
    const { rows } = await this.database.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return this.toPedido(rows[0]);
  }

  // DEFERRED no cierra el pedido: sigue esperando el resultado final del pago.
  async applyPaymentStatus(
    db: Queryable,
    orderId: string,
    paymentStatus: PaymentStatus,
  ): Promise<void> {
    const status = ORDER_STATUS_BY_PAYMENT[paymentStatus];
    if (!status) {
      return;
    }
    await db.query(
      `UPDATE orders SET status = $2
       WHERE id = $1 AND status = $3`,
      [orderId, status, OrderStatus.PENDING_PAYMENT],
    );
  }

  private toPedido(row: OrderRow): Pedido {
    return {
      id: row.id,
      product: row.product,
      amount: Number(row.amount),
      status: row.status,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}
