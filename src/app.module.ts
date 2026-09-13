import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PedidosModule } from './pedidos/pedidos.module';
import { SuscripcionesModule } from './suscripciones/suscripciones.module';
import { PedidosModule } from './pedidos/pedidos.module';

@Module({
  imports: [PedidosModule, SuscripcionesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
