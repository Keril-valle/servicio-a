import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CreatePaymentDto } from './create-payment.dto';
import { PaymentStatus } from '../entities/payment.entity';

export class UpdatePaymentDto extends PartialType(CreatePaymentDto) {
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsString()
  externalPaymentId?: string;
}
