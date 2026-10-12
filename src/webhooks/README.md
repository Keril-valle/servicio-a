# Webhook de pagos

Service A recibe `POST /webhooks/payments` desde el proveedor de pagos. En la
primera demo el proveedor es Service B (`FAKE`).

Configurar `HMAC_SECRET` en el `.env` real (el mismo secreto que usa el proveedor).
`DATABASE_URL` es necesaria para consultar y actualizar pagos y pedidos.

```json
{
  "event": "payment.updated",
  "paymentId": "d81f874c-c790-4e4b-bf48-e0d839fa6f4a",
  "externalPaymentId": "5b0e6d2a-7a51-4f0e-9c1e-0b9a6c2e8f11",
  "status": "APPROVED"
}
```

`paymentId` debe ser el UUID que devuelve `POST /payments`, no el identificador
externo del proveedor. `externalPaymentId` es opcional. Estados permitidos:

| Estado     | Pago                                | Pedido                     |
| ---------- | ----------------------------------- | -------------------------- |
| `DEFERRED` | `PENDING` → `DEFERRED`              | Sigue en `PENDING_PAYMENT` |
| `APPROVED` | `PENDING` o `DEFERRED` → `APPROVED` | `PAID`                     |
| `REJECTED` | `PENDING` o `DEFERRED` → `REJECTED` | `PAYMENT_REJECTED`         |

Headers:

- `Content-Type: application/json`
- `X-Signature`: HMAC-SHA256 hexadecimal de los **bytes exactos** del cuerpo,
  usando `HMAC_SECRET`. No se agrega prefijo `sha256=`.

Ejemplo de firma en el emisor:

```ts
const body = JSON.stringify({
  event: 'payment.updated',
  paymentId,
  status: 'APPROVED',
});
const signature = createHmac('sha256', secret).update(body).digest('hex');
// Enviar body tal cual y signature en X-Signature.
```

`POST /payments` crea el pedido y el pago en `PENDING`. La respuesta HTTP de
Service B no lo aprueba: solo el webhook firmado cambia el estado en PostgreSQL.

## Idempotencia y respuestas

El cambio de estado es atómico: solo se aplica si el pago está en un estado
anterior permitido. Un webhook repetido, o uno que llega tarde (por ejemplo un
`DEFERRED` después de `APPROVED`), se responde con `200` y `applied: false`
sin modificar nada, para que el proveedor no siga reintentando.

- `200`: webhook aceptado (`applied: true` si cambió el estado, `false` si ya estaba procesado).
- `400`: payload inválido.
- `401`: firma ausente o incorrecta.
- `404`: pago inexistente.
- `409`: el pago pertenece a otro proveedor.

Consultas: `GET /payments`, `GET /payments/:id`, `GET /pedidos` y `GET /pedidos/:id`
(UUID). Devuelven `404` si no existe y `400` si el identificador no es un UUID.
