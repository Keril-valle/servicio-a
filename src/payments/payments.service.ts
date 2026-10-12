import {
  Injectable,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { OnvoClient } from '../providers/onvo/onvo.client';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from './entities/payment.entity';

interface PaymentRow extends QueryResultRow {
  id: string;
  orderId: string | null;
  amount: number;
  status: PaymentStatus;
  provider: PaymentProvider;
  externalPaymentId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PaymentConfirmation {
  applied: boolean;
  payment: Payment;
}

// Lo que el frontend necesita para montar el SDK de ONVO y cobrar el Payment Intent.
export interface OnvoCheckout {
  paymentIntentId: string;
  publishableKey: string;
}

// Igual que Payment, más el bloque `onvo` cuando el proveedor es ONVO.
export type CreatedPayment = Payment & { onvo?: OnvoCheckout };

const DEFAULT_PRODUCT = 'Producto A';

const PAYMENT_COLUMNS = `id, order_id AS "orderId", amount::float8 AS amount,
  status, provider, external_payment_id AS "externalPaymentId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

// Estados desde los que un webhook puede mover el pago a cada estado.
const ALLOWED_PREVIOUS: Partial<Record<PaymentStatus, PaymentStatus[]>> = {
  [PaymentStatus.DEFERRED]: [PaymentStatus.PENDING],
  [PaymentStatus.APPROVED]: [PaymentStatus.PENDING, PaymentStatus.DEFERRED],
  [PaymentStatus.REJECTED]: [PaymentStatus.PENDING, PaymentStatus.DEFERRED],
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly pedidosService: PedidosService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly onvoClient: OnvoClient,
  ) {}

  async create(createPaymentDto: CreatePaymentDto): Promise<CreatedPayment> {
    const isOnvo = createPaymentDto.provider === PaymentProvider.ONVO;
    const product = createPaymentDto.product ?? DEFAULT_PRODUCT;
    // Sin claves de ONVO se falla antes de crear el pedido y el pago, no después.
    if (isOnvo) {
      this.onvoClient.assertConfigured();
    }

    const payment = await this.database.transaction(async (client) => {
      const order = await this.pedidosService.create(client, {
        product,
        amount: createPaymentDto.amount,
      });
      const { rows } = await client.query<PaymentRow>(
        `INSERT INTO payments (id, order_id, amount, status, provider, external_payment_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PAYMENT_COLUMNS}`,
        [
          randomUUID(),
          order.id,
          createPaymentDto.amount,
          PaymentStatus.PENDING,
          createPaymentDto.provider,
          null,
        ],
      );
      return this.toPayment(rows[0]);
    });

    return isOnvo
      ? this.processWithOnvo(payment, product)
      : this.processWithFakeProvider(payment);
  }

  async findAll(): Promise<Payment[]> {
    const { rows } = await this.database.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.toPayment(row));
  }

  async findOne(id: string): Promise<Payment> {
    const { rows } = await this.database.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException('Pago no encontrado');
    }
    return this.toPayment(rows[0]);
  }

  async update(
    id: string,
    updatePaymentDto: UpdatePaymentDto,
  ): Promise<Payment | undefined> {
    const fields: Array<[keyof UpdatePaymentDto, string]> = [
      ['amount', 'amount'],
      ['status', 'status'],
      ['provider', 'provider'],
      ['externalPaymentId', 'external_payment_id'],
    ];
    const updates = fields.filter(
      ([key]) => updatePaymentDto[key] !== undefined,
    );
    const values: unknown[] = [id];
    const assignments = updates.map(([key, column], index) => {
      values.push(updatePaymentDto[key]);
      return `${column} = $${index + 2}`;
    });
    assignments.push('updated_at = NOW()');

    const { rows } = await this.database.query<PaymentRow>(
      `UPDATE payments SET ${assignments.join(', ')} WHERE id = $1
       RETURNING ${PAYMENT_COLUMNS}`,
      values,
    );
    return rows[0] ? this.toPayment(rows[0]) : undefined;
  }

  async remove(id: string): Promise<Payment | undefined> {
    const { rows } = await this.database.query<PaymentRow>(
      `DELETE FROM payments WHERE id = $1 RETURNING ${PAYMENT_COLUMNS}`,
      [id],
    );
    return rows[0] ? this.toPayment(rows[0]) : undefined;
  }

  // Crear el Payment Intent no cobra nada: el cobro lo hace el SDK en el navegador y
  // el resultado llega por webhook (POST /webhooks/onvo). Aquí solo se guarda el id de
  // ONVO y se devuelve lo necesario para que el frontend monte el SDK.
  private async processWithOnvo(
    payment: Payment,
    product: string,
  ): Promise<CreatedPayment> {
    let paymentIntentId: string;
    try {
      const intent = await this.onvoClient.createPaymentIntent({
        paymentId: payment.id,
        amount: payment.amount,
        description: `Pago ${product}`,
      });
      paymentIntentId = intent.id;
    } catch (error) {
      // Nada se cobró. Se rechaza el pago para que no quede en PENDING para siempre.
      await this.confirmPayment(
        payment.id,
        PaymentStatus.REJECTED,
        PaymentProvider.ONVO,
      ).catch((rejectError: unknown) =>
        this.logger.error(
          `No se pudo marcar como rechazado el pago ${payment.id}: ${rejectError instanceof Error ? rejectError.message : 'error desconocido'}`,
        ),
      );
      throw error;
    }

    // Se guarda antes de responder: así el webhook siempre encuentra el pago.
    await this.database.query(
      `UPDATE payments SET external_payment_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [payment.id, paymentIntentId],
    );
    const saved = await this.findOne(payment.id);
    return {
      ...saved,
      onvo: {
        paymentIntentId,
        publishableKey: this.onvoClient.getPublishableKey(),
      },
    };
  }

  private async processWithFakeProvider(payment: Payment): Promise<Payment> {
    const serviceBUrl =
      this.configService.get<string>('SERVICE_B_URL') ??
      'http://service-b:3001';

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<{ externalPaymentId?: string }>(
          `${serviceBUrl.replace(/\/$/, '')}/payments`,
          { paymentId: payment.id, amount: payment.amount },
          { timeout: 5000 },
        ),
      );

      // La respuesta HTTP solo acusa recibo; el estado cambia con el webhook firmado.
      if (typeof data?.externalPaymentId === 'string') {
        await this.database.query(
          `UPDATE payments SET external_payment_id = $2, updated_at = NOW()
           WHERE id = $1`,
          [payment.id, data.externalPaymentId],
        );
      }
    } catch (error) {
      throw new ServiceUnavailableException(
        `No se pudo procesar el pago con Service B: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
    return this.findOne(payment.id);
  }

  async confirmPayment(
    id: string,
    status: PaymentStatus,
    provider: PaymentProvider,
  ): Promise<PaymentConfirmation> {
    const allowedPrevious = ALLOWED_PREVIOUS[status];
    if (!allowedPrevious) {
      throw new ConflictException(`Estado no soportado por webhook: ${status}`);
    }

    const updated = await this.database.transaction(async (client) => {
      const { rows } = await client.query<PaymentRow>(
        `UPDATE payments
         SET status = $2, updated_at = NOW()
         WHERE id = $1 AND provider = $3 AND status = ANY($4::payment_status[])
         RETURNING ${PAYMENT_COLUMNS}`,
        [id, status, provider, allowedPrevious],
      );
      if (!rows[0]) {
        return undefined;
      }
      const payment = this.toPayment(rows[0]);
      if (payment.orderId) {
        await this.pedidosService.applyPaymentStatus(
          client,
          payment.orderId,
          status,
        );
      }
      return payment;
    });
    if (updated) {
      return { applied: true, payment: updated };
    }

    const payment = await this.findOne(id);
    if (payment.provider !== provider) {
      throw new ConflictException(
        `El pago no pertenece al proveedor ${provider}`,
      );
    }
    // Duplicados y eventos atrasados se aceptan sin cambios para que el proveedor no reintente.
    if (payment.status !== status) {
      this.logger.warn(
        `Webhook ${status} ignorado para el pago ${id}: ya está en ${payment.status}`,
      );
    }
    return { applied: false, payment };
  }

  private toPayment(row: PaymentRow): Payment {
    return {
      id: row.id,
      orderId: row.orderId,
      amount: Number(row.amount),
      status: row.status,
      provider: row.provider,
      externalPaymentId: row.externalPaymentId,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}
