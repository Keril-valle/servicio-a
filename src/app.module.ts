import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PedidosModule } from './pedidos/pedidos.module';
import { PaymentsModule } from './payments/payments.module';
import { ConfigModule } from '@nestjs/config';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DatabaseModule } from './database/database.module';
import { MetricsModule } from './observability/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    DatabaseModule,
    MetricsModule,
    PedidosModule,
    PaymentsModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
