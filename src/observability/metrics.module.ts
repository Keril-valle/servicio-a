import { Module } from '@nestjs/common';
import { PaymentMetricsService } from './payment-metrics.service';

@Module({
  providers: [PaymentMetricsService],
  exports: [PaymentMetricsService],
})
export class MetricsModule {}
