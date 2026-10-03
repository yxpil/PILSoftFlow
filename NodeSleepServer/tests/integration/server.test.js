'use strict';
/**
 * createSleepServer 集成测试 —— dryRun 模式起真实服务，打状态/控制端点。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createSleepServer } = require('../../lib/sleep');

function getFreePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    }).on('error', reject);
  });
}
function post(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end();
  });
}

test('状态端点返回 JSON；手动触发关机在 dryRun 下不真关机', async () => {
  const listenPort = await getFreePort();
  const statusPort = await getFreePort();
  const cfg = { heavy: { watchPorts: [], listenPorts: [listenPort], idleMinutes: 5, checkIntervalSec: 30, shutdownCmd: 'echo should-not-run', statusPort } };
  const server = createSleepServer(cfg, { log: () => {}, dryRun: true });

  const s = await get(statusPort, '/');
  assert.strictEqual(s.status, 200);
  const j = JSON.parse(s.body);
  assert.strictEqual(j.name, 'heavy');
  assert.strictEqual(j.dryRun, true);
  assert.deepStrictEqual(j.listenPorts, [listenPort]);
  assert.ok(typeof j.idleRemainSec === 'number');

  const shut = await post(statusPort, '/_heavy/shutdown');
  assert.strictEqual(shut.status, 200);
  const sj = JSON.parse(shut.body);
  assert.strictEqual(sj.fired, true, 'dryRun 下也应标记已触发');
  assert.strictEqual(sj.dryRun, true);

  server.stop();
});
