import { PaymentProvider } from '../entities/payment.entity';
import { IsEnum, IsNumber, Min } from 'class-validator';

export class CreatePaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentProvider)
  provider!: PaymentProvider;
}
