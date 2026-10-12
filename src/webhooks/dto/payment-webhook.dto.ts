import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentStatus } from '../../payments/entities/payment.entity';

export const PAYMENT_UPDATED_EVENT = 'payment.updated';

export class PaymentWebhookDto {
  @IsIn([PAYMENT_UPDATED_EVENT])
  event!: string;

  @IsUUID()
  paymentId!: string;

  @IsOptional()
  @IsString()
  externalPaymentId?: string;

  @IsIn([
    PaymentStatus.APPROVED,
    PaymentStatus.REJECTED,
    PaymentStatus.DEFERRED,
  ])
  status!: PaymentStatus;
}
