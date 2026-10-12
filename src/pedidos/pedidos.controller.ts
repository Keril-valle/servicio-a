import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { PedidosService } from './pedidos.service';

// Los pedidos se crean junto con su pago en POST /payments.
@Controller('pedidos')
export class PedidosController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get()
  findAll() {
    return this.pedidosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pedidosService.findOne(id);
  }
}
