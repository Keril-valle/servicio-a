import { PaymentProvider } from '../entities/payment.entity';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreatePaymentDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  product?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentProvider)
  provider!: PaymentProvider;
}
