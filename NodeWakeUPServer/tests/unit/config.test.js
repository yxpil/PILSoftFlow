'use strict';
/**
 * lib/config.js splitHostPort / loadConfig / 路由校验单元测试
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, splitHostPort } = require('../../lib/config');

test('splitHostPort：IPv4 / IPv6 / 无端口', () => {
  assert.deepStrictEqual(splitHostPort('192.168.1.10:8080'), { host: '192.168.1.10', port: 8080 });
  assert.deepStrictEqual(splitHostPort('[::1]:9000'), { host: '::1', port: 9000 });
  const none = splitHostPort('justhost');
  assert.strictEqual(none.host, 'justhost');
  assert.strictEqual(none.port, null);
});

function writeTmp(obj) {
  const f = path.join(os.tmpdir(), 'pilsoftflow-wake-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

const goodRoute = { listenPort: 8080, backend: '127.0.0.1:9000', wol: { mac: 'aa:bb:cc:dd:ee:ff' } };

test('合法路由加载成功，wol.ports 默认 [7,9]', () => {
  const cfg = loadConfig(writeTmp({ proxy: { routes: [goodRoute] } }));
  assert.strictEqual(cfg.proxy.routes.length, 1);
  assert.deepStrictEqual(cfg.proxy.routes[0].wol.ports, [7, 9]);
  assert.strictEqual(cfg.proxy.probeTimeoutMs, 800);
});

test('无路由 → 抛错', () => {
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [] } })), /至少需要/);
});

test('listenPort 越界/非整数 → 抛错', () => {
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [{ ...goodRoute, listenPort: 0 }] } })), /listenPort/);
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [{ ...goodRoute, listenPort: 70000 }] } })), /listenPort/);
});

test('backend 与 backendMac 二选一，格式非法 → 抛错', () => {
  // 两者都没配
  const { backend, ...noBackend } = goodRoute;
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [noBackend] } })), /backend/);
  // backend 格式错
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [{ ...goodRoute, backend: 'nohost' }] } })), /host:port/);
  // backendMac 但 MAC 非法
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [{ listenPort: 8080, backendMac: 'badmac', backendPort: 80, wol: { mac: 'aa:bb:cc:dd:ee:ff' } }] } })), /格式错误/);
});

test('wol.mac 非法 → 抛错（注入防护：脏 MAC 不可用）', () => {
  assert.throws(() => loadConfig(writeTmp({ proxy: { routes: [{ ...goodRoute, wol: { mac: '<script>' } }] } })), /wol.mac/);
});
