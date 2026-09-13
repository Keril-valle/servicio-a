import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PedidosModule } from './pedidos/pedidos.module';
import { SuscripcionesModule } from './suscripciones/suscripciones.module';

@Module({
  imports: [PedidosModule, SuscripcionesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
