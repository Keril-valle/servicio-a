# Métricas de negocio — Service A

## Implementación

Se reutiliza el proveedor global iniciado por
`NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register`.
No se inicia otro `NodeSDK`, `MeterProvider` ni exportador. No se agregaron
dependencias, un endpoint Prometheus ni componentes de infraestructura.

`PaymentsService.create()` guarda el pedido y el pago en una transacción.
`DatabaseService.transaction()` resuelve **después del COMMIT**: se cuenta la
creación al regresar de esa operación, antes de contactar al proveedor. Si
luego falla Service B u ONVO, el pago creado sigue contando porque ya existe.
Un INSERT o COMMIT fallido no incrementa el contador.

`PaymentsService.confirmPayment()` es el punto común de confirmación FAKE/ONVO.
El UPDATE condicional existente permite `PENDING/DEFERRED -> APPROVED/REJECTED`
y actualiza el pedido dentro de la misma transacción. Se cuenta la confirmación
solo después del COMMIT y cuando el UPDATE devolvió un pago actualizado.
La condición atómica existente protege contra duplicados, concurrencia y
eventos atrasados. No se modificaron esas reglas ni la autenticación.

| Instrumento OTLP                           | Tipo      | Nombre esperado con traducción Prometheus habitual |
| ------------------------------------------ | --------- | -------------------------------------------------- |
| `payments_created`                         | Counter   | `payments_created_total`                           |
| `payments_approved`                        | Counter   | `payments_approved_total`                          |
| `payments_rejected`                        | Counter   | `payments_rejected_total`                          |
| `webhooks_received`                        | Counter   | `webhooks_received_total`                          |
| `webhooks_invalid`                         | Counter   | `webhooks_invalid_total`                           |
| `webhook_processing_duration` (unidad `s`) | Histogram | `webhook_processing_duration_seconds`              |

Todos usan únicamente `provider=FAKE|ONVO`. No hay IDs, correos, tokens, firmas
ni secretos como atributos. Los contadores no tienen unidad personalizada ni
sufijo `_total` en el instrumento, para evitar sufijos adicionales al traducir.

La recepción se cuenta para `POST /webhooks/payments` y `POST /webhooks/onvo`
mediante middleware registrado en `main.ts`, antes del parser JSON. Incluye
firmas inválidas, JSON malformado, cuerpos demasiado grandes y la simulación
de tienda caída que lleguen a la aplicación. No incluye rechazos anteriores
en Railway/proxies ni solicitudes a otras rutas o con otros métodos HTTP.

`WebhooksService` cuenta autenticidad inválida exactamente en las ramas de
rechazo 401 existentes: body ausente para FAKE, firma ausente/malformada o HMAC
incorrecto y secreto ONVO ausente/incorrecto. Fallos de PostgreSQL, configuración,
payload y consultas a ONVO **no** incrementan `webhooks_invalid`.

El histograma mide desde el inicio del manejador común del controlador hasta
su finalización: verificación, consulta a ONVO, persistencia y registro de la
recepción. Se registra en `finally` aun con errores, duplicados, eventos ignorados
o tienda caída. No incluye red, envío de la respuesta ni parser JSON: un body
rechazado antes del controlador cuenta recepción, pero no duración de negocio.
Sus límites sugeridos van de 5 ms a 30 s, más el bucket infinito; el SDK/backend
puede cambiar la agregación.

El servicio absorbe fallos síncronos al crear instrumentos o registrar datos,
con un único aviso genérico sin configuración sensible. Sin proveedor activo,
la API de OpenTelemetry es no-op: eso no demuestra exportación. Los errores
asíncronos del envío son responsabilidad del SDK existente.

## Archivos creados y modificados

Rutas relativas a `servicio-a/`:

| Archivo                                                | Responsabilidad                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/observability/metrics.module.ts`                  | Proveer/exportar el servicio compartido.                             |
| `src/observability/payment-metrics.service.ts`         | Instrumentos, atributos, histograma y aislamiento de errores.        |
| `src/observability/webhook-receipt.middleware.ts`      | Contar recepción antes del parser en las dos rutas POST.             |
| `src/observability/payment-metrics.service.spec.ts`    | Probar nombres, proveedores, valores y errores de instrumentos.      |
| `src/observability/webhook-receipt.middleware.spec.ts` | Probar filtrado de rutas y métodos.                                  |
| `src/observability/README.md`                          | Esta guía.                                                           |
| `src/payments/payments.service.ts`                     | Emitir creación/confirmación después de persistencia.                |
| `src/payments/payments.module.ts`                      | Importar `MetricsModule`.                                            |
| `src/payments/payments.service.spec.ts`                | Probar métricas, fallos transaccionales, duplicados y ONVO.          |
| `src/webhooks/webhooks.service.ts`                     | Emitir solo los rechazos de autenticidad.                            |
| `src/webhooks/webhooks.controller.ts`                  | Medir duración de ambos proveedores.                                 |
| `src/webhooks/webhooks.module.ts`                      | Importar `MetricsModule`.                                            |
| `src/webhooks/webhooks.service.spec.ts`                | Distinguir errores de configuración/payload de autenticación.        |
| `src/webhooks/webhooks.controller.spec.ts`             | Pruebas HTTP FAKE, validación de creación, recepción y fallos de BD. |
| `src/webhooks/webhooks.onvo.spec.ts`                   | Pruebas HTTP ONVO, autenticación y clasificación de errores.         |
| `src/app.module.ts`                                    | Importar el módulo para acceso desde el arranque.                    |
| `src/main.ts`                                          | Registrar el middleware antes del parser automático de Nest.         |
| `test/verify-business-metrics-otlp.cjs`                | Verificar OTLP aislado contra un receptor HTTP local.                |

## Pruebas y compilación

Desde `servicio-a/`, con dependencias instaladas:

```powershell
npm test -- --runInBand
npm run build
npm run test:e2e -- --runInBand
node test/verify-business-metrics-otlp.cjs
```

Las pruebas unitarias/HTTP usan mocks de PostgreSQL y proveedores: no cobran,
no conectan a Supabase y no envían datos a Grafana. Los casos de COMMIT fallido
simulan una transacción que rechaza después del trabajo; no prueban PostgreSQL real.

La verificación local requiere compilar primero. Levanta un receptor en
`127.0.0.1` y un proceso separado con **el mismo preload automático**.
Elimina del entorno hijo las variables `OTEL_*` y `NODE_OPTIONS` heredadas,
configura exportación solo al receptor local y genera eventos sintéticos
FAKE/ONVO. Comprueba cinco contadores monotónicos de valor 1 por proveedor y
un histograma en segundos con una muestra de 0.125 s por proveedor.
No carga `.env`, no usa credenciales y no conecta al negocio. Emplea HTTP/JSON para
inspeccionar el payload: **no prueba HTTP/protobuf de Railway ni Grafana Cloud**.

### Resultados de la verificación local de esta implementación

- `npm test -- --runInBand --silent`: **9 suites, 116 pruebas aprobadas**.
- `npm run build`: **correcto**.
- ESLint sobre los archivos TypeScript creados/modificados: **sin errores**.
- `node test/verify-business-metrics-otlp.cjs`: **correcto**, cinco contadores
  y un histograma recibidos por HTTP/JSON local usando el preload existente.
- `npm run test:e2e -- --runInBand`: **falló antes de ejecutar pruebas** por
  carga ESM de `@nestjs/config` en Jest. No se corrigió fuera del alcance.
- Railway/Grafana Cloud: **no verificados**.

## Despliegue en Railway

1. Ejecutar pruebas y compilación local.
2. Publicar los cambios en el repositorio conectado a **Service A** y desplegar
   mediante el flujo habitual. Si los servicios tienen repositorios independientes,
   publicar en el de `servicio-a`, no solo en el padre.
3. Conservar el comando de arranque y las variables actuales de instrumentación.
   No copiar credenciales a archivos versionados.
4. Confirmar que `NODE_OPTIONS` precarga el registro y que
   `OTEL_METRICS_EXPORTER=otlp` está activo. Tener trazas no demuestra por sí solo
   que haya exportación de métricas.
5. Revisar logs de arranque y errores del exportador sin compartir headers,
   connection strings ni secretos. Evitar publicar logs detallados sensibles.

No se ha desplegado esta implementación desde esta sesión.

## Generar eventos de demostración

Usar un entorno de pruebas y valores no sensibles. Crear un pago:

```powershell
$env:SERVICE_A_URL = 'http://localhost:3000' # o URL del merchant de pruebas
$payment = Invoke-RestMethod -Method Post -Uri "$env:SERVICE_A_URL/payments" `
  -ContentType 'application/json' `
  -Body '{"product":"Demo métricas","amount":100,"provider":"FAKE"}'
$env:PAYMENT_ID = $payment.id
```

El flujo normal de Service B genera el WebHook firmado. Para confirmación manual
de desarrollo, usar un pago FAKE aún `PENDING/DEFERRED`. `HMAC_SECRET` debe existir
de forma segura en el entorno del proceso y coincidir con el del merchant;
no escribir su valor en código, esta guía o historial. El ejemplo envía los
mismos bytes firmados y no imprime la firma:

```powershell
@'
const { createHmac } = require('node:crypto');
async function send() {
  if (!process.env.HMAC_SECRET || !process.env.PAYMENT_ID || !process.env.SERVICE_A_URL) {
    throw new Error('Faltan variables del entorno de pruebas');
  }
  const body = JSON.stringify({
    event: 'payment.updated', paymentId: process.env.PAYMENT_ID, status: 'APPROVED',
  });
  const signature = createHmac('sha256', process.env.HMAC_SECRET).update(body).digest('hex');
  const response = await fetch(`${process.env.SERVICE_A_URL.replace(/\/$/, '')}/webhooks/payments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature }, body,
  });
  console.log('HTTP', response.status);
}
send().catch(() => { console.error('Falló el envío de prueba'); process.exitCode = 1; });
'@ | node
```

- Repetir el envío: recepción/duración aumentan otra vez; aprobación no.
- Para rechazo usar **otro pago pendiente** y `status: 'REJECTED'`. Si Service B
  ya resolvió el pago, el evento manual será ignorado correctamente.
- Para autenticidad inválida enviar un JSON válido a `/webhooks/payments` con
  `X-Signature: invalid-test-signature`. Debe responder 401 y contar recibido/ inválido,
  sin cambiar pagos. No provocar caídas reales de BD: se prueban mediante mocks.
- Para ONVO crear con `provider: 'ONVO'` y completar el checkout habitual en
  modo de pruebas. Los eventos `payment-intent.succeeded/failed` llegan a
  `/webhooks/onvo`. Mantener la autenticación y verificación actual: un evento
  inventado que no coincide con ONVO no demuestra una transición. No desactivar
  `ONVO_VERIFY_EVENTS` para obtener métricas.
- Un envío ONVO con `X-Webhook-Secret` deliberadamente incorrecto permite probar
  recibidos/ inválidos con `provider=ONVO`, sin confirmar el pago.

## Verificación en Grafana Cloud

1. Esperar al menos dos ciclos de exportación y la ingestión. El SDK instalado
   usa 60000 ms por defecto si no se define `OTEL_METRIC_EXPORT_INTERVAL`;
   comenzar revisando después de 2–3 minutos.
2. Abrir **Explore**, seleccionar la fuente de métricas Prometheus/Grafana Cloud
   y un intervalo que incluya los eventos, por ejemplo los últimos 30 min.
3. Buscar los nombres:

   ```promql
   {__name__=~"payments_.*|webhooks_.*|webhook_processing_.*"}
   ```

4. Inspeccionar nombres y etiquetas reales. Los nombres de la tabla son
   **esperados**, no observados en Grafana desde esta sesión. La traducción puede
   agregar `_total` y convertir `s` a `_seconds`, o preservar nombres según la
   ingestión. No agregar `_total` al código sin comprobar lo recibido.
5. Filtrar Service A usando etiquetas presentes. Por ejemplo, **solo si existe**,
   `{service_name="servicio-a"}`. Algunos backends usan `job` o `target_info`;
   no asumir que `service.name` se convierte siempre en `service_name`.
6. Las series aparecen al registrar su primer evento: ausencia de inválidos
   puede significar que aún no hubo rechazos. `increase()` necesita muestras y
   puede no reflejar eventos anteriores a la primera exportación. Comprobar
   también el valor del contador y generar más eventos tras obtener una línea base.
7. Si no hay series, verificar exportador de métricas, endpoint/protocolo,
   permisos de credenciales y errores OTLP, sin mostrar valores privados.

El receptor local aceptando datos **no** demuestra recepción en Grafana. Falta
observar las series después del despliegue y comprobar el transporte de producción.

## Consultas PromQL

Suponen los nombres Prometheus de la tabla: reemplazarlos si Explore muestra
otros y agregar el filtro real de Service A/entorno.

```promql
sum(increase(payments_created_total[1h]))
sum(increase(payments_approved_total[1h]))
sum(increase(payments_rejected_total[1h]))
sum(increase(webhooks_received_total[1h]))
sum(increase(webhooks_invalid_total[1h]))
```

Por proveedor y tasas por segundo:

```promql
sum by (provider) (increase(webhooks_received_total[1h]))
sum by (provider) (increase(webhooks_invalid_total[1h]))
sum by (provider) (rate(payments_created_total[5m]))
sum by (provider) (rate(payments_approved_total[5m]))
sum by (provider) (rate(payments_rejected_total[5m]))
```

En paneles Stat usar `[$__range]` para el intervalo seleccionado; en gráficos
de tasa usar `[$__rate_interval]`. `increase()` compensa reinicios observados,
pero extrapola y puede mostrar decimales: no es un conteo contable exacto.

P95 y promedio en segundos, para histograma clásico:

```promql
histogram_quantile(
  0.95,
  sum by (le, provider) (rate(webhook_processing_duration_seconds_bucket[5m]))
)
```

```promql
sum by (provider) (rate(webhook_processing_duration_seconds_sum[5m]))
/
sum by (provider) (rate(webhook_processing_duration_seconds_count[5m]))
```

Si llega un histograma nativo en vez de series `_bucket`, usar el nombre
observado con esta forma:

```promql
histogram_quantile(
  0.95,
  sum by (provider) (rate(webhook_processing_duration_seconds[5m]))
)
```

## Dashboard manual posterior

Crear **MONITOREO DE PAGOS — SERVICE A** con filtro de servicio/entorno:

| Panel                             | Tipo y consulta                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pagos creados                     | Stat: `sum(increase(payments_created_total[$__range]))`                                          |
| Pagos aprobados                   | Stat: `sum(increase(payments_approved_total[$__range]))`                                         |
| Pagos rechazados                  | Stat: `sum(increase(payments_rejected_total[$__range]))`                                         |
| WebHooks recibidos                | Stat: `sum(increase(webhooks_received_total[$__range]))`                                         |
| WebHooks inválidos                | Stat: `sum(increase(webhooks_invalid_total[$__range]))`                                          |
| Tiempo de procesamiento           | Stat: P95, unidad segundos.                                                                      |
| Pagos creados a través del tiempo | Time series: tasa de creados por proveedor.                                                      |
| Aprobaciones vs rechazos          | Time series: tasas de aprobados/rechazados, dos consultas y leyendas separadas.                  |
| WebHooks recibidos por proveedor  | Time series: `sum by (provider) (rate(webhooks_received_total[$__rate_interval]))`.              |
| Errores de WebHook                | Time series: tasa de inválidos por proveedor; son errores de autenticidad, no todos los 4xx/5xx. |
| Latencia del procesamiento        | Time series: P95 y promedio por proveedor.                                                       |

No se creó un dashboard programáticamente.

## Limitaciones y semántica

- Los contadores representan eventos observados desde que empezó la
  instrumentación, no la cantidad histórica de filas de PostgreSQL.
- Es best-effort: una caída entre COMMIT y registro/exportación puede perder
  eventos. No es una auditoría durable ni reemplaza a PostgreSQL.
- El rechazo compensatorio existente al fallar crear el Payment Intent ONVO
  también cuenta si se persiste en `confirmPayment()`. Rechazados no equivale
  necesariamente a cantidad de WebHooks de rechazo.
- El PATCH existente modifica estados mediante `PaymentsService.update()`.
  No se instrumenta como confirmación por WebHook ni se cambió su comportamiento.
  Cambios manuales/externos pueden diferir de los eventos contabilizados.
- No se probó concurrencia contra PostgreSQL real: se preservó el UPDATE atómico
  y se probó el resultado aplicado/no aplicado.
- La suite e2e de arranque falla antes de ejecutar casos por la carga ESM de
  `@nestjs/config` en Jest en este entorno; las suites HTTP usan mocks compatibles.
  No se cambiaron dependencias ni configuración ESM para este trabajo.
- Pendiente validar despliegue y recepción real en Grafana Cloud; no hay
  comprobación de producción desde esta sesión.
