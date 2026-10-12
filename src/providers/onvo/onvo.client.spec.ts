import {
  BadGatewayException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { OnvoClient, toCentavos } from './onvo.client';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

describe('toCentavos', () => {
  it.each([
    [15000, 1500000],
    [12.5, 1250],
    [0.07, 7],
    [1234.56, 123456],
    [0.01, 1],
  ])('₡%s se envía a ONVO como %s centavos', (colones, centavos) => {
    expect(toCentavos(colones)).toBe(centavos);
  });
});

describe('OnvoClient', () => {
  const secretKey = 'onvo_test_secret_key_abc123';
  const paymentId = 'd81f874c-c790-4e4b-bf48-e0d839fa6f4a';
  let post: jest.Mock;
  let get: jest.Mock;
  let config: Record<string, string | undefined>;
  let client: OnvoClient;

  beforeEach(() => {
    post = jest.fn();
    get = jest.fn();
    config = { ONVO_SECRET_KEY: secretKey };
    client = new OnvoClient(
      { post, get } as unknown as HttpService,
      { get: (key: string) => config[key] } as unknown as ConfigService,
    );
  });

  describe('createPaymentIntent', () => {
    it('manda monto en centavos, CRC, metadata con nuestro id y la clave como Bearer', async () => {
      post.mockReturnValue(
        of({
          data: {
            id: 'cl4de13uc457301lor2o0q9w1',
            status: 'requires_payment_method',
          },
        }),
      );

      const intent = await client.createPaymentIntent({
        paymentId,
        amount: 15000,
        description: 'Pago Producto A',
      });

      expect(post).toHaveBeenCalledTimes(1);
      const [url, body, options] = post.mock.calls[0] as [
        string,
        unknown,
        { headers: Record<string, string>; timeout: number },
      ];
      expect(url).toBe('https://api.onvopay.com/v1/payment-intents');
      expect(body).toEqual({
        amount: 1500000,
        currency: 'CRC',
        description: 'Pago Producto A',
        metadata: { paymentId },
      });
      expect(options.headers.Authorization).toBe(`Bearer ${secretKey}`);
      expect(options.timeout).toBeGreaterThan(0);
      expect(intent).toEqual({
        id: 'cl4de13uc457301lor2o0q9w1',
        status: 'requires_payment_method',
        metadata: undefined,
      });
    });

    it('sin ONVO_SECRET_KEY falla antes de llamar a ONVO', async () => {
      config.ONVO_SECRET_KEY = undefined;

      await expect(
        client.createPaymentIntent({
          paymentId,
          amount: 100,
          description: 'x',
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(post).not.toHaveBeenCalled();
    });

    it('un 4xx de ONVO es 502 y muestra el motivo, sin filtrar la clave', async () => {
      post.mockReturnValue(
        throwError(() => ({
          message: `Request failed with status code 400 (Bearer ${secretKey})`,
          response: {
            status: 400,
            data: { statusCode: 400, message: ['amount must be an integer'] },
          },
        })),
      );

      const error = await client
        .createPaymentIntent({ paymentId, amount: 100, description: 'x' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadGatewayException);
      const message = (error as BadGatewayException).message;
      expect(message).toContain('HTTP 400');
      expect(message).toContain('amount must be an integer');
      expect(message).not.toContain(secretKey);
    });

    it('si el texto del error trae la clave, se oculta', async () => {
      post.mockReturnValue(
        throwError(() => ({
          message: `fallo con Bearer ${secretKey}`,
          response: { status: 400, data: {} },
        })),
      );

      const error = await client
        .createPaymentIntent({ paymentId, amount: 100, description: 'x' })
        .catch((e: unknown) => e);

      expect((error as Error).message).not.toContain(secretKey);
      expect((error as Error).message).toContain('[clave oculta]');
    });

    it('un 401 de ONVO es 502 (clave inválida)', async () => {
      post.mockReturnValue(
        throwError(() => ({
          message: 'Unauthorized',
          response: {
            status: 401,
            data: { statusCode: 401, error: 'Unauthorized' },
          },
        })),
      );

      await expect(
        client.createPaymentIntent({
          paymentId,
          amount: 100,
          description: 'x',
        }),
      ).rejects.toThrow(/HTTP 401/);
    });

    it('si ONVO no responde (sin respuesta HTTP) es 503', async () => {
      post.mockReturnValue(
        throwError(() => new Error('timeout of 10000ms exceeded')),
      );

      await expect(
        client.createPaymentIntent({
          paymentId,
          amount: 100,
          description: 'x',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('un 5xx de ONVO es 503', async () => {
      post.mockReturnValue(
        throwError(() => ({
          message: 'Bad gateway',
          response: { status: 502, data: {} },
        })),
      );

      await expect(
        client.createPaymentIntent({
          paymentId,
          amount: 100,
          description: 'x',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('una respuesta sin id no se acepta', async () => {
      post.mockReturnValue(of({ data: { status: 'requires_payment_method' } }));

      await expect(
        client.createPaymentIntent({
          paymentId,
          amount: 100,
          description: 'x',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('getPaymentIntent', () => {
    it('consulta por id y devuelve id, status y metadata', async () => {
      get.mockReturnValue(
        of({
          data: {
            id: 'clpiment0001',
            status: 'succeeded',
            metadata: { paymentId },
            amount: 1500000,
          },
        }),
      );

      const intent = await client.getPaymentIntent('clpiment0001');

      const [url, options] = get.mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(url).toBe(
        'https://api.onvopay.com/v1/payment-intents/clpiment0001',
      );
      expect(options.headers.Authorization).toBe(`Bearer ${secretKey}`);
      expect(intent).toEqual({
        id: 'clpiment0001',
        status: 'succeeded',
        metadata: { paymentId },
      });
    });

    it('escapa el id para que no altere la ruta', async () => {
      get.mockReturnValue(of({ data: { id: 'x', status: 'succeeded' } }));

      await client.getPaymentIntent('../payment-methods');

      expect((get.mock.calls[0] as [string])[0]).toBe(
        'https://api.onvopay.com/v1/payment-intents/..%2Fpayment-methods',
      );
    });

    it('un 404 de ONVO es 502', async () => {
      get.mockReturnValue(
        throwError(() => ({
          message: 'Not Found',
          response: {
            status: 404,
            data: { message: 'No payment intent found' },
          },
        })),
      );

      await expect(client.getPaymentIntent('nope')).rejects.toThrow(/HTTP 404/);
    });
  });
});
