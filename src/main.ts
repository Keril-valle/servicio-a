import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { PaymentMetricsService } from './observability/payment-metrics.service';
import { createWebhookReceiptMiddleware } from './observability/webhook-receipt.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(createWebhookReceiptMiddleware(app.get(PaymentMetricsService)));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
