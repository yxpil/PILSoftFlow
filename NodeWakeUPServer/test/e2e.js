'use strict';
// NodeWakeUPServer 端到端测试(纯 Node 内置模块,零依赖)
// 运行: node test/e2e.js
//
// T1 WOL 魔法包:本地 UDP 7/9 收包验证
// T2 proxy 转发:后端在线 -> 直连透传
// T3 唤醒流程:后端离线 -> 503 唤醒页 + WOL -> 后端上线 -> 自动透传
// T4 诊断端点:/_wol/status + 手动唤醒
// T5 backendMac + ARP 动态 IP(注入 fake 解析器)
// T6 ARP 解析函数
// T7 管理面板页面

const http = require('http');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

const BACKEND_PORT = 18100;
const PROXY_PORT = 18080;
const STATUS_PORT = 19090;

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : ''));
  }
}

function httpGet(port, p, timeoutMs) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, timeout: timeoutMs || 4000, agent: false }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on('timeout', function () { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', function () { resolve({ status: 0, body: '' }); });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function pollHttp(port, p, wantStatus, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await httpGet(port, p, 1500);
    if (res.status === wantStatus) return res;
    await sleep(300);
  }
  return { status: 0, body: '' };
}

function startBackend() {
  const srv = http.createServer(function (req, res) {
    if (req.url === '/hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hi');
    } else {
      res.writeHead(404);
      res.end('no');
    }
  });
  return new Promise(function (resolve) {
    srv.listen(BACKEND_PORT, '127.0.0.1', function () { resolve(srv); });
  });
}

function startUdpSniffer(port) {
  const sock = dgram.createSocket('udp4');
  const pkts = [];
  return new Promise(function (resolve) {
    sock.on('message', function (msg) { pkts.push(msg); });
    sock.bind(port, '127.0.0.1', function () { resolve({ sock: sock, pkts: pkts }); });
  });
}

function isMagicPacket(buf, macHex) {
  if (buf.length !== 102) return false;
  for (let i = 0; i < 6; i++) if (buf[i] !== 0xff) return false;
  const mac = Buffer.from(macHex.replace(/:/g, ''), 'hex');
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      if (buf[6 + i * 6 + j] !== mac[j]) return false;
    }
  }
  return true;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-test-'));
  const cfgFile = path.join(tmpDir, 'config.json');
  const cfg = {
    proxy: {
      host: '127.0.0.1',
      probeTimeoutMs: 300,
      wakeTimeoutSec: 15,
      wakeRetries: 5,
      wakeIntervalMs: 400,
      statusPort: STATUS_PORT,
      routes: [{
        name: '测试后端',
        listenPort: PROXY_PORT,
        backend: '127.0.0.1:' + BACKEND_PORT,
        wol: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '127.0.0.1', ports: [7, 9] }
      }]
    }
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  const children = [];
  let sniffer7, sniffer9;

  try {
    // ===== T1 WOL 魔法包 =====
    console.log('\n[T1] WOL 魔法包');
    const { sendWol } = require(path.join(ROOT, 'lib', 'wol.js'));
    sniffer7 = await startUdpSniffer(7);
    sniffer9 = await startUdpSniffer(9);
    const ok = await sendWol({ mac: 'AA:BB:CC:DD:EE:FF', broadcast: '127.0.0.1', ports: [7, 9] }, function () {});
    check('T1 sendWol 返回成功', ok === 2, 'ok=' + ok);
    await sleep(200);
    const p7 = sniffer7.pkts.filter(function (b) { return isMagicPacket(b, 'AA:BB:CC:DD:EE:FF'); });
    const p9 = sniffer9.pkts.filter(function (b) { return isMagicPacket(b, 'AA:BB:CC:DD:EE:FF'); });
    check('T1 UDP:7 收到 102 字节魔法包', p7.length >= 1, 'count=' + p7.length);
    check('T1 UDP:9 收到 102 字节魔法包', p9.length >= 1, 'count=' + p9.length);

    // ===== 起 proxy + backend =====
    console.log('\n[启动] proxy + backend');
    let backend = await startBackend();
    const proxy = spawn(process.execPath, [SERVER, 'start', '--config', cfgFile], { cwd: ROOT });
    children.push(proxy);
    await sleep(800);

    // ===== T2 在线转发 =====
    console.log('\n[T2] 后端在线转发');
    const r2 = await httpGet(PROXY_PORT, '/hello');
    check('T2 GET /hello 返回 200', r2.status === 200, 'status=' + r2.status);
    check('T2 响应体为 hi', r2.body === 'hi', 'body=' + r2.body);

    // ===== T3 唤醒流程 =====
    console.log('\n[T3] 后端离线 -> 唤醒页 + WOL -> 上线后透传');
    const p7before = sniffer7.pkts.length;
    const p9before = sniffer9.pkts.length;
    await new Promise(function (r) { backend.close(r); });
    backend = null;
    await sleep(400);
    const r3 = await httpGet(PROXY_PORT, '/hello');
    check('T3 离线时返回 503', r3.status === 503, 'status=' + r3.status);
    check('T3 响应含"正在唤醒"', r3.body.indexOf('正在唤醒服务器') >= 0, 'body len=' + r3.body.length);
    check('T3 响应含自动刷新', r3.body.indexOf('http-equiv="refresh"') >= 0, '');
    await sleep(500);
    check('T3 唤醒期间 UDP:7 收到魔法包', sniffer7.pkts.length > p7before, 'new=' + (sniffer7.pkts.length - p7before));
    check('T3 唤醒期间 UDP:9 收到魔法包', sniffer9.pkts.length > p9before, 'new=' + (sniffer9.pkts.length - p9before));

    // 后端重新上线 -> 浏览器自动刷新 -> 透传
    backend = await startBackend();
    const r3b = await pollHttp(PROXY_PORT, '/hello', 200, 20000);
    check('T3 后端上线后自动透传 200', r3b.status === 200, 'status=' + r3b.status + ' body=' + r3b.body);
    check('T3 透传内容正确', r3b.body === 'hi', 'body=' + r3b.body);

    // ===== T4 诊断端点 =====
    console.log('\n[T4] 诊断端点');
    const r4 = await httpGet(STATUS_PORT, '/_wol/status');
    check('T4 /_wol/status 返回 200', r4.status === 200, 'status=' + r4.status);
    let statusJson = null;
    try { statusJson = JSON.parse(r4.body); } catch (e) {}
    check('T4 status 为合法 JSON', !!statusJson, '');
    check('T4 包含路由信息', statusJson && statusJson.routes && statusJson.routes.length === 1, '');
    check('T4 记录过唤醒次数', statusJson && statusJson.routes[0] && statusJson.routes[0].wolCount >= 1, '');
    const r4w = await httpGet(STATUS_PORT, '/_wol/wake?route=' + PROXY_PORT);
    check('T4 手动唤醒端点 200', r4w.status === 200, 'status=' + r4w.status + ' body=' + r4w.body);

    // ===== T5 backendMac + ARP 动态 IP 解析 =====
    console.log('\n[T5] backendMac + ARP 动态 IP(注入 fake 解析器)');
    const { createProxy } = require(path.join(ROOT, 'lib', 'proxy.js'));
    const ARP_PORT = 18082;
    let fakeIp = null; // 模拟 ARP 表:MAC -> 当前 IP
    const p5 = createProxy({
      proxy: {
        host: '127.0.0.1', probeTimeoutMs: 300, wakeTimeoutSec: 8, wakeRetries: 3,
        wakeIntervalMs: 400, statusPort: 0,
        routes: [{
          name: 'ARP后端', listenPort: ARP_PORT,
          backendMac: 'AA:BB:CC:DD:EE:FF', backendPort: BACKEND_PORT,
          wol: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '127.0.0.1', ports: [7, 9] }
        }]
      }
    }, {
      log: function () {},
      arpResolver: function (mac) { return fakeIp; }
    });
    await sleep(500);
    const p7t5 = sniffer7.pkts.length;
    const r5a = await httpGet(ARP_PORT, '/hello');
    check('T5a ARP 未解析返回 503', r5a.status === 503, 'status=' + r5a.status);
    check('T5a 响应含唤醒页', r5a.body.indexOf('正在唤醒') >= 0, '');
    await sleep(300);
    check('T5a 唤醒期间 UDP:7 收到魔法包', sniffer7.pkts.length > p7t5, 'new=' + (sniffer7.pkts.length - p7t5));
    fakeIp = '127.0.0.1';
    const r5b = await pollHttp(ARP_PORT, '/hello', 200, 15000);
    check('T5b ARP 解析后透传 200', r5b.status === 200, 'status=' + r5b.status);
    check('T5b 内容正确', r5b.body === 'hi', 'body=' + r5b.body);
    fakeIp = '127.0.0.2';
    await sleep(600);
    const r5c = await httpGet(ARP_PORT, '/hello');
    check('T5c IP 变化后跟随新解析(503)', r5c.status === 503, 'status=' + r5c.status);
    fakeIp = '127.0.0.1';
    const r5d = await pollHttp(ARP_PORT, '/hello', 200, 15000);
    check('T5d IP 恢复后重新透传 200', r5d.status === 200 && r5d.body === 'hi', '');
    p5.stop();

    // ===== T6 ARP 解析函数单元测试 =====
    console.log('\n[T6] ARP 解析函数');
    const { parseLinuxArp, parseWindowsArp } = require(path.join(ROOT, 'lib', 'arp.js'));
    const linuxArpText = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      '192.168.1.100    0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0',
      '192.168.1.101    0x1         0x2         11:22:33:44:55:66     *        eth0',
      '192.168.1.102    0x1         0x0         00:00:00:00:00:00     *        eth0'
    ].join('\n');
    check('T6 Linux ARP 解析命中', parseLinuxArp(linuxArpText, 'aabbccddeeff') === '192.168.1.100', '');
    check('T6 Linux ARP 未命中返回 null', parseLinuxArp(linuxArpText, 'ffffffffffff') === null, '');
    check('T6 Linux ARP 跳过未完成/空 MAC 条目', parseLinuxArp(linuxArpText, '000000000000') === null, '');
    const winArpText = [
      'Interface: 192.168.1.50 --- 0x5',
      '  Internet Address      Physical Address      Type',
      '  192.168.1.100         aa-bb-cc-dd-ee-ff     dynamic',
      '  192.168.1.101         11-22-33-44-55-66     static'
    ].join('\n');
    check('T6 Windows ARP 解析命中', parseWindowsArp(winArpText, 'aabbccddeeff') === '192.168.1.100', '');
    check('T6 Windows ARP 未命中返回 null', parseWindowsArp(winArpText, 'aabbccddee00') === null, '');

    // ===== T7 管理面板页面 =====
    console.log('\n[T7] 管理面板');
    const r7 = await httpGet(STATUS_PORT, '/');
    check('T7 面板返回 200', r7.status === 200, 'status=' + r7.status);
    check('T7 面板含分代理服务器区块', r7.body.indexOf('分代理服务器') >= 0, '');
    check('T7 面板含重型服务器端区块', r7.body.indexOf('重型服务器端') >= 0, '');
    check('T7 面板含正在唤醒状态逻辑', r7.body.indexOf('正在唤醒') >= 0, '');
  } finally {
    children.forEach(function (c) { try { c.kill(); } catch (e) {} });
    if (sniffer7) sniffer7.sock.close();
    if (sniffer9) sniffer9.sock.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n========== 汇总: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试崩溃:', e);
  process.exit(2);
});
