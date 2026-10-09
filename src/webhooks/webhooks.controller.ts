import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('fake')
  @HttpCode(200)
  receiveFakeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
  ) {
    return this.webhooksService.verifyAndProcess(req.rawBody, signature);
  }
}
