// Verificación local aislada: usa el mismo preload de producción, no otro SDK.
// No se conecta a PostgreSQL, ONVO ni Grafana; no utiliza credenciales OTLP.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { resolve } = require('node:path');

async function main() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.url, '/v1/metrics');
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^OTEL_|^NODE_OPTIONS$/i.test(key),
    ),
  );
  Object.assign(env, {
    OTEL_SERVICE_NAME: 'servicio-a-otlp-local-check',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'otlp',
    // JSON permite inspeccionar el payload sin incorporar un decoder/dependencia.
    // Railway continúa usando http/protobuf, sin cambios.
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_METRIC_EXPORT_TIMEOUT: '1000',
    OTEL_LOG_LEVEL: 'none',
  });
  const code = `
    const { PaymentMetricsService } = require('./dist/observability/payment-metrics.service');
    const service = new PaymentMetricsService();
    for (const provider of ['FAKE', 'ONVO']) {
      service.paymentCreated(provider);
      service.paymentConfirmed(provider, 'APPROVED');
      service.paymentConfirmed(provider, 'REJECTED');
      service.webhookReceived(provider);
      service.webhookInvalid(provider);
      service.recordWebhookDuration(provider, 0.125);
    }
    setTimeout(() => process.exit(0), 4000);
  `;
  try {
    const child = spawn(
      process.execPath,
      [
        '--require',
        '@opentelemetry/auto-instrumentations-node/register',
        '-e',
        code,
      ],
      {
        cwd: resolve(__dirname, '..'),
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill(), 60000);
    try {
      const exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(
        exitCode,
        0,
        errors || 'El proceso de verificación no terminó correctamente',
      );
    } finally {
      clearTimeout(timeout);
    }
    const exported = new Map();
    for (const request of requests) {
      for (const resource of request.resourceMetrics ?? []) {
        assert.ok(
          resource.resource.attributes.some(
            (attribute) =>
              attribute.key === 'service.name' &&
              attribute.value.stringValue === 'servicio-a-otlp-local-check',
          ),
        );
        for (const scope of resource.scopeMetrics ?? []) {
          if (scope.scope.name === 'servicio-a.payment-business') {
            for (const metric of scope.metrics ?? [])
              exported.set(metric.name, metric);
          }
        }
      }
    }
    for (const name of [
      'payments_created',
      'payments_approved',
      'payments_rejected',
      'webhooks_received',
      'webhooks_invalid',
    ]) {
      const metric = exported.get(name);
      assert.ok(metric?.sum?.isMonotonic, `No se exportó el contador ${name}`);
      assert.equal(metric.sum.dataPoints.length, 2);
      for (const point of metric.sum.dataPoints) {
        assert.equal(Number(point.asInt ?? point.asDouble), 1);
        assert.equal(point.attributes.length, 1);
        assert.equal(point.attributes[0].key, 'provider');
        assert.ok(
          ['FAKE', 'ONVO'].includes(point.attributes[0].value.stringValue),
        );
      }
    }
    const histogram = exported.get('webhook_processing_duration');
    assert.equal(histogram?.unit, 's');
    assert.equal(histogram.histogram.dataPoints.length, 2);
    for (const point of histogram.histogram.dataPoints) {
      assert.equal(Number(point.count), 1);
      assert.equal(point.sum, 0.125);
      assert.ok(point.explicitBounds.includes(0.005));
      assert.equal(point.attributes[0].key, 'provider');
    }
    console.log(
      'OTLP local OK: 5 contadores + 1 histograma, proveedores FAKE/ONVO, preload existente.',
    );
    console.log(
      'No verifica recepción en Grafana Cloud ni transporte http/protobuf.',
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
