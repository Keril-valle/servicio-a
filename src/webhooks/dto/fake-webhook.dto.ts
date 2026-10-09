import { IsIn, IsUUID } from 'class-validator';
import { PaymentStatus } from '../../payments/entities/payment.entity';

export class FakeWebhookDto {
  @IsUUID()
  paymentId!: string;

  @IsIn([PaymentStatus.APPROVED, PaymentStatus.REJECTED])
  status!: PaymentStatus;
}
