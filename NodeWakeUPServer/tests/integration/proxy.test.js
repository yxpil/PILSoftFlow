'use strict';
/**
 * createProxy 集成测试 —— 真实 TCP 回路。
 * 覆盖：在线后端双向透传、诊断状态端点、未知路由 404。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { createProxy } = require('../../lib/proxy');

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    }).on('error', reject);
  });
}

function tcpOnce(port, payload, marker) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(payload));
    const c = [];
    const timer = setTimeout(() => { sock.destroy(); resolve(Buffer.concat(c).toString('utf8')); }, 2000);
    sock.on('data', (d) => {
      c.push(d);
      const s = Buffer.concat(c).toString('utf8');
      if (marker && s.includes(marker)) { clearTimeout(timer); sock.destroy(); resolve(s); }
    });
    sock.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(c).toString('utf8')); });
    sock.on('error', reject);
  });
}

test('在线后端：TCP 请求被透传到上游并返回上游响应', async () => {
  const upPort = await freePort();
  const up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('UPSTREAM-BODY-123'); });
  await new Promise((r) => up.listen(upPort, '127.0.0.1', r));

  const listenPort = await freePort();
  const statusPort = await freePort();
  const proxy = createProxy({ proxy: { host: '127.0.0.1', statusPort, probeTimeoutMs: 300, wakeTimeoutSec: 1, wakeRetries: 0, wakeIntervalMs: 100, routes: [ { name: 'web', listenPort, backend: `127.0.0.1:${upPort}`, wol: { mac: 'aa:bb:cc:dd:ee:ff', broadcast: '127.0.0.1', ports: [9] } } ] } }, { log: () => {} });

  await new Promise((r) => setTimeout(r, 300)); // 等路由监听就绪
  try {
    const resp = await tcpOnce(listenPort, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 'UPSTREAM-BODY-123');
    assert.match(resp, /UPSTREAM-BODY-123/, '上游响应应被透传');

    // 诊断状态端点
    const st = await httpGet(statusPort, '/_wol/status');
    assert.strictEqual(st.status, 200);
    const j = JSON.parse(st.body);
    assert.strictEqual(j.routes[0].listenPort, listenPort);
    assert.strictEqual(j.routes[0].online, true);

    // 注入：未知 route → 404，不崩溃
    const unk = await httpGet(statusPort, '/_wol/wake?route=99999');
    assert.strictEqual(unk.status, 404);
  } finally {
    proxy.stop();
    up.close();
  }
});
