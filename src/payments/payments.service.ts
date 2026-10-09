import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  NotImplementedException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { Pool, QueryResultRow } from 'pg';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from './entities/payment.entity';

interface PaymentRow extends QueryResultRow {
  id: string;
  amount: number;
  status: PaymentStatus;
  provider: PaymentProvider;
  externalPaymentId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private pool?: Pool;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto): Promise<Payment> {
    const { rows } = await this.getPool().query<PaymentRow>(
      `INSERT INTO payments (id, amount, status, provider, external_payment_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount::float8 AS amount, status, provider,
                 external_payment_id AS "externalPaymentId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        randomUUID(),
        createPaymentDto.amount,
        PaymentStatus.PENDING,
        createPaymentDto.provider,
        null,
      ],
    );
    const payment = this.toPayment(rows[0]);

    if (payment.provider === PaymentProvider.ONVO) {
      throw new NotImplementedException(
        'El proveedor ONVO aún no está integrado',
      );
    }

    return this.processWithFakeProvider(payment);
  }

  async findAll(): Promise<Payment[]> {
    const { rows } = await this.getPool().query<PaymentRow>(
      `SELECT id, amount::float8 AS amount, status, provider,
              external_payment_id AS "externalPaymentId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM payments ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.toPayment(row));
  }

  async findOne(id: string): Promise<Payment> {
    const { rows } = await this.getPool().query<PaymentRow>(
      `SELECT id, amount::float8 AS amount, status, provider,
              external_payment_id AS "externalPaymentId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM payments WHERE id = $1`,
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

    const { rows } = await this.getPool().query<PaymentRow>(
      `UPDATE payments SET ${assignments.join(', ')} WHERE id = $1
       RETURNING id, amount::float8 AS amount, status, provider,
                 external_payment_id AS "externalPaymentId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      values,
    );
    return rows[0] ? this.toPayment(rows[0]) : undefined;
  }

  async remove(id: string): Promise<Payment | undefined> {
    const { rows } = await this.getPool().query<PaymentRow>(
      `DELETE FROM payments WHERE id = $1
       RETURNING id, amount::float8 AS amount, status, provider,
                 external_payment_id AS "externalPaymentId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id],
    );
    return rows[0] ? this.toPayment(rows[0]) : undefined;
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private getPool() {
    if (this.pool) {
      return this.pool;
    }

    const connectionString = this.configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new InternalServerErrorException('Falta configurar DATABASE_URL');
    }

    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    return this.pool;
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
        await this.getPool().query(
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

  async confirmFakePayment(
    id: string,
    status: PaymentStatus,
  ): Promise<Payment> {
    if (![PaymentStatus.APPROVED, PaymentStatus.REJECTED].includes(status)) {
      throw new ConflictException(
        'La confirmación debe ser APPROVED o REJECTED',
      );
    }
    const { rows } = await this.getPool().query<PaymentRow>(
      `UPDATE payments
       SET status = $2, updated_at = NOW()
       WHERE id = $1 AND provider = $3 AND status = $4
       RETURNING id, amount::float8 AS amount, status, provider,
                 external_payment_id AS "externalPaymentId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, status, PaymentProvider.FAKE, PaymentStatus.PENDING],
    );
    if (rows[0]) {
      return this.toPayment(rows[0]);
    }

    const payment = await this.findOne(id);
    if (payment.provider !== PaymentProvider.FAKE) {
      throw new ConflictException('El pago no pertenece al proveedor FAKE');
    }
    if (payment.status !== status) {
      throw new ConflictException('El pago ya tiene un estado final diferente');
    }
    // Reenvíos del mismo webhook son idempotentes y no alteran updatedAt.
    return payment;
  }

  private toPayment(row: PaymentRow): Payment {
    return {
      id: row.id,
      amount: Number(row.amount),
      status: row.status,
      provider: row.provider,
      externalPaymentId: row.externalPaymentId,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}
