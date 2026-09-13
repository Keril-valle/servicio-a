import { of } from 'rxjs';
import { createHmac } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { PedidosService } from './pedidos.service';
import { SuscripcionesService } from '../suscripciones/suscripciones.service';

jest.mock('@nestjs/axios', () => ({
  HttpService: class HttpService {},
}));

describe('PedidosService', () => {
  it('dispara un webhook firmado para las suscripciones de pedido.creado', async () => {
    const post = jest.fn().mockReturnValue(of({ status: 200 }));
    const httpService = { post } as unknown as HttpService;
    const suscripcionesService = new SuscripcionesService();
    const service = new PedidosService(httpService, suscripcionesService);

    suscripcionesService.create({
      url: 'http://service-b:3001/webhooks/pedido',
      event: 'pedido.creado',
    });

    const pedido = service.create({ producto: 'Café', monto: 12.5 });
    await new Promise((resolve) => setImmediate(resolve));

    const body = JSON.stringify(pedido);
    const expectedSignature = createHmac('sha256', 'desarrollo-secret')
      .update(body)
      .digest('hex');

    expect(post).toHaveBeenCalledWith(
      'http://service-b:3001/webhooks/pedido',
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Signature': expectedSignature,
        }),
      }),
    );
  });
});