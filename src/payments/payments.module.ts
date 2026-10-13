import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PedidosModule } from '../pedidos/pedidos.module';
import { OnvoModule } from '../providers/onvo/onvo.module';
import { MetricsModule } from '../observability/metrics.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [HttpModule, PedidosModule, OnvoModule, MetricsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
