import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PedidosService } from './pedidos.service';
import { PedidosController } from './pedidos.controller';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';

@Module({
  imports: [HttpModule, SuscripcionesModule],
  controllers: [PedidosController],
  providers: [PedidosService],
})
export class PedidosModule {}
