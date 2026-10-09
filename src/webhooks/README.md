# Confirmaciones del Fake Provider

Service A recibe `POST /webhooks/fake`. No se modifica Service B.

Configurar `HMAC_SECRET` en el `.env` real (el mismo secreto que usa el proveedor).
`DATABASE_URL` es necesaria para consultar y actualizar pagos.

```json
{
  "paymentId": "d81f874c-c790-4e4b-bf48-e0d839fa6f4a",
  "status": "APPROVED"
}
```

`paymentId` debe ser el UUID que devuelve `POST /payments`, no el identificador
externo del proveedor. Se permiten `APPROVED` y `REJECTED`.

Headers:

- `Content-Type: application/json`
- `X-Signature`: HMAC-SHA256 hexadecimal de los **bytes exactos** del cuerpo,
  usando `HMAC_SECRET`. No se agrega prefijo `sha256=`.

Ejemplo de firma en el emisor:

```ts
const body = JSON.stringify({ paymentId, status: 'APPROVED' });
const signature = createHmac('sha256', secret).update(body).digest('hex');
// Enviar body tal cual y signature en X-Signature.
```

El pago se crea como `PENDING`. La respuesta HTTP de Service B no lo aprueba:
solo el webhook firmado confirma el estado en PostgreSQL.

Respuestas:

- `200`: confirmación aplicada, o repetición del mismo estado final.
- `400`: payload inválido.
- `401`: firma ausente o incorrecta.
- `404`: pago inexistente.
- `409`: proveedor distinto de `FAKE` o estado final contrario al ya registrado.

Consultas: `GET /payments` y `GET /payments/:id` (UUID). El segundo devuelve
`404` si el pago no existe y `400` si el identificador no es un UUID.
