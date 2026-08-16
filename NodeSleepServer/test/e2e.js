'use strict';
// NodeSleepServer 端到端测试(纯 Node 内置模块,零依赖)
// 运行: node test/e2e.js
//
// T1 空闲关机守护:持续访问不触发 / 停止访问后触发(DRY-RUN) / 单次触发保护
// T2 状态/控制端点:状态 JSON + 手动触发关机
// T3 watchPorts 生产模式(/proc/net/tcp 解析)

const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

const HEAVY_PORT = 18081;
const STATUS_PORT = 19091;

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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function httpGet(port, p, method, timeoutMs) {
  return new Promise(function (resolve) {
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method || 'GET', timeout: timeoutMs || 4000, agent: false }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on('timeout', function () { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', function () { resolve({ status: 0, body: '' }); });
    req.end();
  });
}

function tcpConnect(port) {
  return new Promise(function (resolve) {
    const s = net.connect({ host: '127.0.0.1', port: port });
    s.once('connect', function () { s.destroy(); resolve(true); });
    s.once('error', function () { resolve(false); });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-test-'));
  const cfgFile = path.join(tmpDir, 'config.json');
  const cfg = {
    heavy: { listenPorts: [HEAVY_PORT], idleMinutes: 0.05, checkIntervalSec: 1, shutdownCmd: 'echo SHUTDOWN', statusPort: STATUS_PORT }
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  const children = [];
  try {
    // ===== 启动守护(DRY-RUN)=====
    console.log('\n[启动] sleep 守护(dry-run)');
    const server = spawn(process.execPath, [SERVER, 'start', '--config', cfgFile, '--dry-run'], { cwd: ROOT });
    server.out = '';
    server.stdout.on('data', function (d) { server.out += d; });
    server.stderr.on('data', function (d) { server.out += d; });
    children.push(server);
    await sleep(600);

    // ===== T1 空闲关机守护 =====
    console.log('\n[T1] 空闲关机守护');
    const keepAlive = setInterval(function () { tcpConnect(HEAVY_PORT); }, 400);
    await sleep(4000);
    clearInterval(keepAlive);
    check('T1a 持续连接时不触发关机', server.out.indexOf('DRY-RUN: 跳过') < 0, 'out=' + server.out.slice(-200));
    const r1start = Date.now();
    await sleep(5000);
    check('T1b 停止访问后触发 DRY-RUN', server.out.indexOf('DRY-RUN: 跳过') >= 0, 'out=' + server.out.slice(-200));
    check('T1b 触发时间合理', (Date.now() - r1start) < 9000, 'elapsed=' + (Date.now() - r1start));
    const firedCount = (server.out.match(/DRY-RUN: 跳过/g) || []).length;
    check('T1c 只触发一次', firedCount === 1, 'fired=' + firedCount);

    // ===== T2 状态/控制端点 =====
    console.log('\n[T2] 状态/控制端点');
    const r2 = await httpGet(STATUS_PORT, '/');
    check('T2 状态端点返回 200', r2.status === 200, 'status=' + r2.status);
    let s2 = null;
    try { s2 = JSON.parse(r2.body); } catch (e) {}
    check('T2 状态为合法 JSON', !!s2, 'body=' + r2.body.slice(0, 80));
    check('T2 含 idleMinutes 与倒计时', s2 && typeof s2.idleMinutes === 'number' && typeof s2.idleRemainSec === 'number', '');
    check('T2 标记 dry-run 模式', s2 && s2.dryRun === true, 'dryRun=' + (s2 && s2.dryRun));
    check('T2 含监听端口', s2 && Array.isArray(s2.listenPorts) && s2.listenPorts.indexOf(HEAVY_PORT) >= 0, '');
    const r2b = await httpGet(STATUS_PORT, '/_heavy/shutdown', 'POST');
    check('T2 手动关机端点 200', r2b.status === 200, 'status=' + r2b.status + ' body=' + r2b.body);
    await sleep(300);
    check('T2 手动触发写入日志', server.out.indexOf('手动触发关机') >= 0, 'out=' + server.out.slice(-150));

    // ===== T3 watchPorts 生产模式 =====
    console.log('\n[T3] watchPorts /proc/net/tcp 解析');
    const { scanEstablishedPorts } = require(path.join(ROOT, 'lib', 'sleep.js'));
    // 端口 1F90=8080, 2328=9000; st: 01=ESTABLISHED, 06=TIME_WAIT, 0A=LISTEN
    const fakeProcTcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:1F90 0100007F:C001 01 00000000:00000000 00:00000000 00000000     0        0 101 1 0000000000000000 20 4 30 10 0',
      '   2: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 102 1 0000000000000000 100 0 0 10 0',
      '   3: 0100007F:2328 0100007F:D002 06 00000000:00000000 00:00000000 00000000     0        0 103 1 0000000000000000 20 4 30 10 0'
    ].join('\n');
    const procTcp6 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 0100007F:D003 01 00000000:00000000 00:00000000 00000000     0        0 104 1 0000000000000000 20 4 30 10 0\n';
    const ports = scanEstablishedPorts({
      files: ['/fake/tcp', '/fake/tcp6'],
      readFileSync: function (f) {
        if (f === '/fake/tcp') return fakeProcTcp;
        if (f === '/fake/tcp6') return procTcp6;
        throw new Error('ENOENT');
      }
    });
    check('T3 识别 8080 的 ESTABLISHED 连接', ports.has(8080), 'set=' + JSON.stringify(Array.from(ports)));
    check('T3 9000 仅 LISTEN/TIME_WAIT 不计入', !ports.has(9000), 'set=' + JSON.stringify(Array.from(ports)));
    const none = scanEstablishedPorts({ files: ['/nonexist'], readFileSync: function () { throw new Error('ENOENT'); } });
    check('T3 文件缺失时返回空集不崩溃', none.size === 0, 'size=' + none.size);
  } finally {
    children.forEach(function (c) { try { c.kill(); } catch (e) {} });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n========== 汇总: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试崩溃:', e);
  process.exit(2);
});
