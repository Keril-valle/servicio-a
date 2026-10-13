import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { OnvoModule } from '../providers/onvo/onvo.module';
import { MetricsModule } from '../observability/metrics.module';
import { WebhookLogService } from './webhook-log.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PaymentsModule, OnvoModule, MetricsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookLogService],
})
export class WebhooksModule {}
