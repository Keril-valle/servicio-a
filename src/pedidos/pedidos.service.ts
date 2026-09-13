import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHmac, randomUUID } from 'node:crypto';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { UpdatePedidoDto } from './dto/update-pedido.dto';
import { SuscripcionesService } from '../suscripciones/suscripciones.service';

export interface Pedido {
  id: string;
  producto: string;
  monto: number;
  fecha: string;
}

@Injectable()
export class PedidosService {
  private readonly logger = new Logger(PedidosService.name);
  private readonly pedidos: Pedido[] = [];
  private readonly hmacSecret = process.env.HMAC_SECRET ?? 'desarrollo-secret';
  private readonly maxAttempts = 3;

  constructor(
    private readonly httpService: HttpService,
    private readonly suscripcionesService: SuscripcionesService,
  ) {}

  create(createPedidoDto: CreatePedidoDto) {
    const pedido: Pedido = {
      id: randomUUID(),
      ...createPedidoDto,
      fecha: new Date().toISOString(),
    };

    this.pedidos.push(pedido);
    void this.notifySubscribers('pedido.creado', pedido);
    return pedido;
  }

  findAll() {
    return this.pedidos;
  }

  findOne(id: number) {
    return this.pedidos[id];
  }

  update(id: number, updatePedidoDto: UpdatePedidoDto) {
    return `This action updates a #${id} pedido`;
  }

  remove(id: number) {
    return `This action removes a #${id} pedido`;
  }

  private async notifySubscribers(event: string, payload: Pedido) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', this.hmacSecret).update(body).digest('hex');
    const subscriptions = this.suscripcionesService.findByEvent(event);

    await Promise.all(
      subscriptions.map((subscription) =>
        this.sendWebhook(subscription.url, body, signature),
      ),
    );
  }

  private async sendWebhook(url: string, body: string, signature: string) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await firstValueFrom(
          this.httpService.post(url, body, {
            headers: {
              'Content-Type': 'application/json',
              'X-Signature': signature,
            },
          }),
        );
        return;
      } catch (error) {
        if (attempt === this.maxAttempts) {
          this.logger.error(`No se pudo entregar el webhook a ${url}`, error);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
}
