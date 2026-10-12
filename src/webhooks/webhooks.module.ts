import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { WebhookLogService } from './webhook-log.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PaymentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookLogService],
})
export class WebhooksModule {}
