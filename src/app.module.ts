import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PedidosModule } from './pedidos/pedidos.module';
import { SuscripcionesModule } from './suscripciones/suscripciones.module';
import { PaymentsModule } from './payments/payments.module';
import { ConfigModule } from '@nestjs/config';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    PedidosModule,
    SuscripcionesModule,
    PaymentsModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
