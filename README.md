# Service A: tienda (Merchant API)

Service A es la **tienda** del proyecto de investigación sobre webhooks. Crea pedidos y pagos, delega el cobro a un proveedor (`FAKE`, que es Service B, u `ONVO`, la API de ONVO en modo de prueba), recibe las confirmaciones del proveedor y actualiza los pagos y pedidos en PostgreSQL (Supabase).

> Este documento describe el código actual de `servicio-a/`. El panorama general del proyecto está en el [README de la raíz](../README.md). La información de Grafana Cloud de A y B está en [`../Grafana/README.md`](../Grafana/README.md).

## Contenido

1. [Rol y alcance](#1-rol-y-alcance)
2. [Arquitectura](#2-arquitectura)
3. [Endpoints](#3-endpoints)
4. [Modelo de datos](#4-modelo-de-datos)
5. [Flujos](#5-flujos)
6. [Seguridad](#6-seguridad)
7. [Configuración](#7-configuración)
8. [Ejecución local](#8-ejecución-local)
9. [Pruebas](#9-pruebas)
10. [Observabilidad](#10-observabilidad)
11. [Despliegue](#11-despliegue)
12. [Limitaciones conocidas](#12-limitaciones-conocidas)
13. [Estructura del código](#13-estructura-del-código)

---

## 1. Rol y alcance

| Aspecto     | Valor                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Función     | Tienda: crea pedidos y pagos, y recibe el resultado del cobro                                        |
| Stack       | NestJS 11, TypeScript, PostgreSQL (Supabase) con `pg`, `@nestjs/axios` y `class-validator`           |
| Puerto      | `3000` (variable `PORT`)                                                                             |
| Repositorio | <https://github.com/Keril-valle/servicio-a>, rama `master`                                           |
| Proveedores | `FAKE`: Service B (simulado). `ONVO`: API de ONVO con claves de prueba (`onvo_test_…`)               |
| Webhooks    | **Recibe** de B (`POST /webhooks/payments`) y de ONVO (`POST /webhooks/onvo`). **No emite** webhooks |

A **no** cobra por sí mismo: en ONVO, el cobro lo hace el SDK en el navegador con la clave publicable. A **no** tiene autenticación de usuarios ni de clientes de la API.

## 2. Arquitectura

| Módulo           | Ubicación             | Responsabilidad                                                                     |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `AppModule`      | `src/app.module.ts`   | Raíz. Carga la configuración desde `../.env` y `.env`                               |
| `DatabaseModule` | `src/database/`       | Pool de `pg` y transacciones (`COMMIT` o `ROLLBACK`)                                |
| `PedidosModule`  | `src/pedidos/`        | Pedidos (`orders`): se crean junto con el pago y cambian según su resultado         |
| `PaymentsModule` | `src/payments/`       | Pagos: creación, consulta, `PATCH`, `DELETE` y la confirmación común de FAKE y ONVO |
| `OnvoModule`     | `src/providers/onvo/` | Cliente HTTP de la API de ONVO (`https://api.onvopay.com`)                          |
| `WebhooksModule` | `src/webhooks/`       | Receptores de webhooks, registro de recibidos y simulación de tienda caída          |
| `MetricsModule`  | `src/observability/`  | Métricas de negocio con OpenTelemetry (§10)                                         |

`src/main.ts` crea la aplicación con `rawBody: true`, porque la firma se verifica sobre los bytes exactos. Además registra el middleware que cuenta la recepción de webhooks, activa un `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted` (los campos no declarados responden `400`) y habilita CORS.

## 3. Endpoints

### 3.1 Estado

| Método | Ruta | Respuesta                                                                    |
| ------ | ---- | ---------------------------------------------------------------------------- |
| `GET`  | `/`  | `"Hello World!"`. Lo usan `run.sh` y `run.ps1` como comprobación de arranque |

### 3.2 Pagos: `/payments`

| Método   | Ruta            | Entrada                                                                                                       | Notas                                                                                                                                                                                   |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/payments`     | `{ "product"?: string (1–120), "amount": number (≥ 0.01, máximo 2 decimales), "provider": "FAKE" \| "ONVO" }` | Crea pedido y pago en `PENDING` dentro de una transacción. Con `FAKE` llama a B y responde el pago en `PENDING`. Con `ONVO` responde además `onvo: { paymentIntentId, publishableKey }` |
| `GET`    | `/payments`     | —                                                                                                             | Todos los pagos, del más reciente al más antiguo. Sin paginación                                                                                                                        |
| `GET`    | `/payments/:id` | UUID                                                                                                          | `400` si el id no es UUID; `404` si no existe                                                                                                                                           |
| `PATCH`  | `/payments/:id` | `{ "amount"?, "provider"?, "status"?, "externalPaymentId"? }`                                                 | Cambia el pago directamente: no aplica las reglas de los webhooks ni actualiza el pedido. El id no se valida como UUID                                                                  |
| `DELETE` | `/payments/:id` | —                                                                                                             | Elimina el pago. El id no se valida como UUID                                                                                                                                           |

### 3.3 Pedidos: `/pedidos`

| Método | Ruta           | Notas                                                              |
| ------ | -------------- | ------------------------------------------------------------------ |
| `GET`  | `/pedidos`     | Todos los pedidos, del más reciente al más antiguo. Sin paginación |
| `GET`  | `/pedidos/:id` | `400` si no es UUID; `404` si no existe                            |

Los pedidos no tienen `POST`: se crean junto con el pago en `POST /payments`.

### 3.4 Webhooks y simulación: `/webhooks`

| Método | Ruta                   | Entrada                                                                                                                                                             | Notas                                                                                                                                                                                      |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/webhooks/payments`   | Cabecera `X-Signature` y cuerpo `{ "event": "payment.updated", "paymentId": UUID, "externalPaymentId"?: string, "status": "APPROVED" \| "REJECTED" \| "DEFERRED" }` | Proveedor **FAKE**. Responde `200` con `applied: true` si cambió el pago, o `applied: false` si ya estaba procesado. `externalPaymentId` se valida, pero no se usa para actualizar el pago |
| `POST` | `/webhooks/onvo`       | Cabecera `X-Webhook-Secret` y sobre `{ "type", "data" }` de ONVO                                                                                                    | Proveedor **ONVO**. Los eventos que el sistema no usa responden `200` y se ignoran, para que ONVO no reintente                                                                             |
| `GET`  | `/webhooks/recibidos`  | —                                                                                                                                                                   | Últimas 100 peticiones recibidas, aceptadas o rechazadas, de la más reciente a la más antigua                                                                                              |
| `GET`  | `/webhooks/simulacion` | —                                                                                                                                                                   | Estado de la simulación: `{ "storeDown": boolean }`                                                                                                                                        |
| `PUT`  | `/webhooks/simulacion` | `{ "storeDown": boolean }`                                                                                                                                          | Mientras esté activa, ambos endpoints de webhook responden `503`                                                                                                                           |

Respuestas de error de los webhooks:

| Código      | Causa                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | JSON inválido; cuerpo que no cumple el DTO; ONVO sin `type` o sin `data.id`                                                                  |
| `401`       | FAKE: falta `X-Signature`, formato inválido o firma incorrecta. ONVO: `X-Webhook-Secret` ausente o incorrecto. Cuerpo vacío                  |
| `404`       | FAKE: el pago no existe                                                                                                                      |
| `409`       | FAKE: el pago pertenece a otro proveedor                                                                                                     |
| `500`       | Falta `HMAC_SECRET` u `ONVO_WEBHOOK_SECRET`, o un error interno, por ejemplo de la base de datos                                             |
| `502`/`503` | ONVO: `502` si ONVO rechaza la consulta; `503` si no hay respuesta o ONVO responde con error del servidor. Simulación de tienda caída: `503` |

## 4. Modelo de datos

La base es PostgreSQL en Supabase. Las migraciones están en `supabase/migrations/` y deben aplicarse en orden, con `supabase db push` o pegándolas en el SQL Editor.

| Migración                                | Contenido                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261008000000_create_payments.sql`     | Tipos `payment_status` (`PENDING`, `APPROVED`, `REJECTED`) y `payment_provider` (`FAKE`, `ONVO`); tabla `payments`; trigger de `updated_at`; RLS habilitado           |
| `20261011000000_orders_and_deferred.sql` | Añade `DEFERRED` a `payment_status`; tipo `order_status` (`PENDING_PAYMENT`, `PAID`, `PAYMENT_REJECTED`); tabla `orders`; columna `payments.order_id`; RLS habilitado |

| Tabla      | Columnas principales                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments` | `id` (UUID generado por el backend), `order_id` (nulo en pagos anteriores a la migración), `amount` (`numeric(12,2)`, mayor que 0), `status`, `provider`, `external_payment_id`, `created_at`, `updated_at` |
| `orders`   | `id`, `product` (1–120 caracteres), `amount`, `status`, `created_at`, `updated_at`                                                                                                                          |

Reglas de los webhooks (`ALLOWED_PREVIOUS` en `payments.service.ts`):

| Estado recibido | Se aplica solo si el pago está en | Efecto en el pedido        |
| --------------- | --------------------------------- | -------------------------- |
| `DEFERRED`      | `PENDING`                         | Sigue en `PENDING_PAYMENT` |
| `APPROVED`      | `PENDING` o `DEFERRED`            | Pasa a `PAID`              |
| `REJECTED`      | `PENDING` o `DEFERRED`            | Pasa a `PAYMENT_REJECTED`  |

El cambio es un `UPDATE` condicional dentro de una transacción: el pago y el pedido cambian juntos, y el pedido solo cambia si sigue en `PENDING_PAYMENT`. Un evento repetido o atrasado no modifica nada.

## 5. Flujos

### 5.1 Pago FAKE (Service B)

1. `POST /payments` con `provider: "FAKE"` inserta el pedido (`PENDING_PAYMENT`) y el pago (`PENDING`) en una transacción.
2. A llama a `POST {SERVICE_B_URL}/payments` con `{ paymentId, amount }`, con timeout de 5 s. B responde `PROCESSING` y su `externalPaymentId`, que A guarda. Si B no responde, A devuelve `503` y el pago queda en `PENDING`.
3. B procesa con demora (`PROCESSING_DELAY_MS`, 3000 ms por defecto). Si el monto es mayor o igual que `DEFERRED_THRESHOLD` (50000 por defecto), envía primero `DEFERRED`. Después, la parte entera par se aprueba (`APPROVED`) y la impar se rechaza (`REJECTED`).
4. B firma el cuerpo y lo envía a `/webhooks/payments`. A verifica la firma, valida el DTO y aplica la transición.
5. Un webhook repetido o atrasado responde `200` con `applied: false`.

### 5.2 Pago ONVO

1. `POST /payments` con `provider: "ONVO"`. Antes de crear registros, A comprueba que existan `ONVO_SECRET_KEY` y `ONVO_PUBLISHABLE_KEY`. Si faltan, responde `500`.
2. Se crean el pedido y el pago en `PENDING`. Después A llama a `POST https://api.onvopay.com/v1/payment-intents` con el monto en céntimos (`Math.round(amount × 100)`), moneda `CRC` y `metadata.paymentId`.
3. A guarda el id del Payment Intent en `external_payment_id` y responde con `onvo: { paymentIntentId, publishableKey }`. El navegador usa la clave publicable con el SDK de ONVO para cobrar. La clave secreta nunca sale de A.
4. Si ONVO no crea el intent, A marca el pago como `REJECTED` para que no quede en `PENDING` y responde `502` o `503`.
5. ONVO llama a `/webhooks/onvo` con `X-Webhook-Secret`. Para `payment-intent.succeeded` y `payment-intent.failed`, A busca el pago por el id del intent o por `metadata.paymentId`. Si `ONVO_VERIFY_EVENTS` no vale `false`, consulta el intent en ONVO y aplica el cambio solo si el estado real coincide con el evento.
6. `payment-intent.deferred` no cambia el estado: responde `applied: false`.

### 5.3 Simulación de tienda caída

Con `PUT /webhooks/simulacion` y `{ "storeDown": true }`, ambos endpoints de webhook responden `503` y registran `STORE_DOWN`. B reintenta tres veces (esperas de 500 ms y 1 s) y marca la entrega como `FAILED`. Al desactivar la simulación, el reenvío se hace a mano desde B con `POST /webhooks/entregas/:id/reenviar`.

### 5.4 Registro de recepción

`WebhookLogService` guarda en memoria hasta 100 entradas. Cada una incluye la fecha, el código HTTP, el resultado (`APPLIED`, `DUPLICATE`, `INVALID_SIGNATURE`, `STORE_DOWN` o `REJECTED`), la firma (solo en FAKE), el cuerpo (hasta 4000 caracteres), `paymentId` y `status`. El `X-Webhook-Secret` de ONVO no se guarda.

## 6. Seguridad

| Tema                  | Estado real                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firma FAKE            | HMAC-SHA256 en hexadecimal sobre los bytes exactos del cuerpo, con `HMAC_SECRET`. La cabecera `X-Signature` debe tener 64 caracteres hexadecimales, sin prefijo `sha256=`. La comparación usa `timingSafeEqual` |
| Verificación ONVO     | ONVO no firma el cuerpo: envía un secreto fijo en `X-Webhook-Secret`. A compara los hashes SHA-256 de ambos valores con `timingSafeEqual`. Por defecto confirma el estado consultando a ONVO                    |
| Secretos              | `HMAC_SECRET`, `ONVO_SECRET_KEY`, `ONVO_WEBHOOK_SECRET` y `DATABASE_URL` se leen solo de la configuración (variables de entorno o `.env`, que no se versiona). Los errores de ONVO sustituyen la clave secreta por `[clave oculta]`                          |
| Configuración ausente | Sin `HMAC_SECRET` u `ONVO_WEBHOOK_SECRET`, los webhooks responden `500` y no aceptan nada                                                                                                                       |
| Repeticiones          | La firma FAKE no incluye fecha ni nonce. La idempotencia evita cambiar el estado dos veces, pero una captura válida puede reenviarse y quedar registrada                                                        |
| API pública           | Sin autenticación: `POST`, `PATCH` y `DELETE` de `/payments`, y `PUT /webhooks/simulacion`, no piden credenciales                                                                                               |
| TLS a PostgreSQL      | `ssl: { rejectUnauthorized: false }`: cifra la conexión, pero no verifica el certificado del servidor                                                                                                           |
| CORS                  | `enableCors()` sin opciones: permite cualquier origen                                                                                                                                                           |
| Supabase RLS          | Habilitado en `payments` y `orders`. El backend accede con `DATABASE_URL`                                                                                                                                       |

## 7. Configuración

A lee las variables con `ConfigService` y `process.env`. Si existen `../.env` y `.env`, se cargan en ese orden. Una variable definida en el sistema (por ejemplo en Railway o Docker) tiene prioridad sobre los archivos.

| Variable                 | Obligatoria            | Valor por defecto       | Uso                                                                                        |
| ------------------------ | ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | Sí                     | —                       | PostgreSQL de Supabase. Sin ella, las operaciones con base de datos responden `500`        |
| `HMAC_SECRET`            | Sí, para webhooks FAKE | —                       | Clave compartida con B. Debe ser idéntica en A y B                                         |
| `SERVICE_B_URL`          | Recomendada            | `http://service-b:3001` | Dirección de B para crear pagos FAKE                                                       |
| `PORT`                   | No                     | `3000`                  | Puerto de escucha                                                                          |
| `ONVO_SECRET_KEY`        | Sí, para pagos ONVO    | —                       | Clave secreta de prueba (`onvo_test_…`). Solo en el servidor                               |
| `ONVO_PUBLISHABLE_KEY`   | Sí, para pagos ONVO    | —                       | Clave publicable que recibe el frontend                                                    |
| `ONVO_WEBHOOK_SECRET`    | Sí, para webhooks ONVO | —                       | Valor que ONVO muestra al registrar la URL del webhook                                     |
| `ONVO_VERIFY_EVENTS`     | No                     | `true`                  | Solo `false` desactiva la consulta a ONVO. Usarlo únicamente en pruebas locales sin acceso |
| `NODE_OPTIONS`, `OTEL_*` | Solo en Railway        | —                       | Instrumentación y exportación de OpenTelemetry (§10). Los valores no se documentan aquí    |

Los valores reales se guardan en `.env` (que no se versiona), en las variables de Docker o en Railway.

## 8. Ejecución local

### Con Docker (recomendado para la demo)

Desde la carpeta de infraestructura (`investigacion-webhooks-infra-`):

```bash
cp .env.example .env     # completar HMAC_SECRET y DATABASE_URL
./run.sh                 # macOS / Linux
.\run.ps1                # Windows (PowerShell)
```

Service A queda disponible en `http://localhost:3000`.

### Sin Docker

```bash
cd servicio-a
npm ci
npm run start:dev
```

Necesita un `.env` (en `servicio-a/` o en la raíz) con `DATABASE_URL`, `HMAC_SECRET` y `SERVICE_B_URL=http://localhost:3001`. Para B, ver [`servicio-b/README.md`](../servicio-b/README.md).

### Prueba rápida con FAKE

```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"product":"Producto A","amount":2,"provider":"FAKE"}'
```

Unos segundos después, `curl http://localhost:3000/payments` debe mostrar `APPROVED`. Con `"amount": 3` el resultado es `REJECTED`. En PowerShell, usar `curl.exe`.

## 9. Pruebas

Desde `servicio-a/`:

```powershell
npm test -- --runInBand --silent
npm run build
node test/verify-business-metrics-otlp.cjs   # requiere haber compilado
npm run test:e2e -- --runInBand
```

Resultados verificados en local el 2026-10-13:

| Comprobación                       | Resultado                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                         | **9 suites y 116 pruebas aprobadas**                                                                                                      |
| `npm run build`                    | Correcto                                                                                                                                  |
| `verify-business-metrics-otlp.cjs` | Correcto: 5 contadores y 1 histograma recibidos por un receptor local                                                                     |
| `npm run test:e2e`                 | **Falla antes de ejecutar casos**: Jest no puede cargar `@nestjs/config` (ESM) desde CommonJS. No se ha cambiado la configuración de Jest |

Las pruebas unitarias y HTTP usan mocks de PostgreSQL, ONVO y Service B. No cobran, no se conectan a Supabase y no envían datos a Grafana.

Archivos de prueba: `app.controller.spec.ts`, `payments.service.spec.ts`, `webhooks.service.spec.ts`, `webhooks.controller.spec.ts`, `webhooks.onvo.spec.ts`, `pedidos.service.spec.ts`, `onvo.client.spec.ts`, `payment-metrics.service.spec.ts` y `webhook-receipt.middleware.spec.ts`.

## 10. Observabilidad

### 10.1 Cómo funciona

- **Instrumentación automática**: en Railway, `NODE_OPTIONS` carga `@opentelemetry/auto-instrumentations-node/register`. Ese preload crea el único proveedor global de OpenTelemetry y genera trazas y métricas HTTP y de Node.js.
- **Métricas de negocio**: `PaymentMetricsService` usa `metrics.getMeter('servicio-a.payment-business', '1.0.0')` sobre ese proveedor. No crea otro SDK, otro `MeterProvider` ni un endpoint Prometheus.
- Sin proveedor activo, por ejemplo en local, la API de OpenTelemetry no hace nada y el servicio funciona igual.
- Los fallos al crear o registrar una métrica se absorben: el negocio continúa y se escribe un aviso genérico una sola vez.

### 10.2 Métricas de negocio

| Instrumento                   | Tipo             | Se incrementa cuando                                                                             | Atributo   |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| `payments_created`            | Contador         | Se guardan el pedido y el pago, después del `COMMIT` y antes de contactar al proveedor           | `provider` |
| `payments_approved`           | Contador         | Se persiste una transición a `APPROVED` (webhook FAKE o webhook ONVO verificado)                 | `provider` |
| `payments_rejected`           | Contador         | Se persiste una transición a `REJECTED`, incluida la compensación si ONVO no crea el intent      | `provider` |
| `webhooks_received`           | Contador         | Llega un `POST` a `/webhooks/payments` o `/webhooks/onvo`, antes del parser JSON                 | `provider` |
| `webhooks_invalid`            | Contador         | Falla la autenticidad: firma FAKE ausente o incorrecta, o `X-Webhook-Secret` de ONVO incorrecto  | `provider` |
| `webhook_processing_duration` | Histograma (`s`) | Termina el procesamiento de un webhook que llegó al controlador, aceptado, duplicado o rechazado | `provider` |

El atributo `provider` vale `FAKE` u `ONVO`. No se registran IDs, correos, tokens, firmas ni secretos. Los nombres de esta tabla son los del código. En Grafana Cloud, los contadores reciben el sufijo `_total` y el histograma el sufijo `_seconds`; ver [`../Grafana/README.md`](../Grafana/README.md).

### 10.3 Semántica

- Los contadores cuentan desde que arranca el proceso. Se reinician con cada despliegue y no son una auditoría.
- Los pagos solo suman cuando el `UPDATE` condicional aplica un cambio: un webhook repetido no suma.
- `DEFERRED` no tiene contador propio.
- `webhooks_received` también cuenta peticiones rechazadas antes del controlador, como JSON malformado o un cuerpo demasiado grande. No cuenta rechazos de proxies anteriores a la aplicación.

### 10.4 Pendientes

- En Railway, `OTEL_LOG_LEVEL` de A está en `debug`. Genera muchos registros; conviene volver a `error` o `warn` después de diagnosticar. B usa `error`.

Detalles de implementación, decisiones y pruebas: [`src/observability/README.md`](src/observability/README.md).

## 11. Despliegue

| Dato                         | Valor                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plataforma                   | Railway, entorno `production`                                                                                                                                                                                 |
| URL pública                  | <https://servicio-a-production.up.railway.app>                                                                                                                                                                |
| Rama desplegada              | `master`                                                                                                                                                                                                      |
| Build                        | `Dockerfile`: `npm ci`, `npm run build` y una imagen final con `npm ci --omit=dev` que ejecuta `node dist/main` en el puerto `3000`                                                                           |
| Último despliegue verificado | `6577f356-642b-44f9-8956-85c960d45451`, **SUCCESS**, commit `cd518647e5c1291a61fdde425401f51c7e5f7102` («feat: add OpenTelemetry payment and webhook business metrics»), creado el 2026-10-13 a las 15:42 UTC |

### Comprobar qué versión está desplegada

Un `push` no garantiza un despliegue. Para confirmar qué commit está activo en Railway:

```powershell
railway deployment list --project <PROJECT_ID> --environment production --service <SERVICE_ID> --limit 1 --json
```

Revisar `status`, que debe ser `SUCCESS`, y `meta.commitHash` y `meta.branch`. Los IDs de proyecto y servicio aparecen en el panel de Railway.

Antes de publicar, compilar, ejecutar las pruebas y revisar los logs de arranque sin compartir variables ni cabeceras.

## 12. Limitaciones conocidas

- **Estado en memoria**: el registro de webhooks (100 entradas) y los contadores de OpenTelemetry se pierden al reiniciar. Los pagos y pedidos sí persisten en PostgreSQL.
- **Sin autenticación ni autorización** en la API pública. `PATCH` y `DELETE` de `/payments` cambian o borran pagos sin reglas y sin tocar el pedido asociado.
- **Sin validación de UUID en `PATCH` y `DELETE`**, a diferencia de `GET /payments/:id`.
- **`POST /payments` no es idempotente**: cada llamada crea otro pedido y otro pago, aunque el contenido sea el mismo.
- **Sin reconciliación**: si B se reinicia mientras procesa un pago, no reenvía el webhook y el pago de A queda en `PENDING`. Si B no responde al crear el pago, A devuelve `503` y no reintenta.
- **Firma FAKE sin fecha ni nonce**: vulnerable a repeticiones. Solo la idempotencia del estado limita el efecto.
- **TLS a PostgreSQL sin verificación del certificado** y **CORS abierto** a cualquier origen.
- **Listados sin paginación** en `/payments` y `/pedidos`.
- **La suite e2e no ejecuta casos**, por el problema ESM de `@nestjs/config` en Jest.
- **Referencias faltantes**: los comentarios del código citan `ONVO_CONTRACT.md`, que no está en el workspace local.
- **Documentación antigua**: `PROJECT_CONTEXT.md`, en la raíz, describe una etapa anterior (pedidos en memoria, sin PostgreSQL ni ONVO). No debe usarse como referencia del estado actual.

## 13. Estructura del código

```text
servicio-a/
├── Dockerfile
├── package.json / package-lock.json
├── .env.example
├── README.md                      ← este documento
├── supabase/migrations/           ← esquema de payments y orders
├── src/
│   ├── main.ts                    ← rawBody, middleware de métricas, ValidationPipe, CORS
│   ├── app.module.ts / app.controller.ts / app.service.ts
│   ├── database/                  ← pool de pg y transacciones
│   ├── pedidos/                   ← pedidos (orders)
│   ├── payments/                  ← pagos, DTOs y entidades
│   ├── providers/onvo/            ← cliente de la API de ONVO
│   ├── webhooks/                  ← receptores FAKE y ONVO, registro y simulación
│   └── observability/             ← métricas de negocio y middleware de recepción
└── test/                          ← e2e (pendiente) y verificación OTLP local
```

### Documentación relacionada

- [`../README.md`](../README.md): panorama del proyecto y ejecución con Docker.
- [`src/webhooks/README.md`](src/webhooks/README.md): contrato del webhook de pagos.
- [`src/observability/README.md`](src/observability/README.md): métricas de negocio con OpenTelemetry.
- [`../Grafana/README.md`](../Grafana/README.md): Grafana Cloud para A y B.
