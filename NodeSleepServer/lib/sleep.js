'use strict';
// NodeSleepServer - 重型服务器端:空闲自动关机守护
//
// 两种活跃检测模式(可同时启用,任一活跃即重置计时):
//   watchPorts  : Linux 生产模式。周期性扫描 /proc/net/tcp(+tcp6),
//                 若任一业务端口存在 ESTABLISHED 连接则视为活跃。
//                 不占用业务端口,与真实服务共存。
//   listenPorts : 占用端口模式(测试/无真实服务场景),连接即活跃。
//
// 空闲超过 idleMinutes -> 执行 shutdownCmd。--dry-run 只打日志不真关机。
// 可选 statusPort 提供状态/控制 HTTP 端点(供 NodeWakeUPServer 管理面板查询)。

const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// 扫描 /proc/net/tcp 与 tcp6,返回活跃的本地端口集合。
// 可注入 opts.files(文件路径列表)与 opts.readFileSync 以便单元测试。
function scanEstablishedPorts(opts) {
  opts = opts || {};
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const files = opts.files || ['/proc/net/tcp', '/proc/net/tcp6'];
  const active = new Set();
  for (const f of files) {
    let txt;
    try {
      txt = readFileSync(f, 'utf8');
    } catch (e) {
      continue; // 非 Linux 或无权限,跳过
    }
    const lines = txt.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 4) continue;
      if (parts[3] !== '01') continue; // 01 = ESTABLISHED
      const la = parts[1].split(':');
      if (la.length !== 2) continue;
      const port = parseInt(la[1], 16);
      if (!isNaN(port)) active.add(port);
    }
  }
  return active;
}

function createSleepServer(cfg, opts) {
  const log = opts.log;
  const dryRun = !!opts.dryRun;
  const { watchPorts, listenPorts, idleMinutes, checkIntervalSec, shutdownCmd } = cfg.heavy;

  let lastActive = Date.now();
  const idleMs = idleMinutes * 60000;
  const servers = [];
  let fired = false;
  let stopping = false;

  function touch() {
    lastActive = Date.now();
  }

  // 模式一:直接监听端口
  for (const port of listenPorts) {
    const srv = net.createServer(function (sock) {
      touch();
      sock.resume(); // 只计数,不消费业务数据
      sock.on('error', function () {});
    });
    srv.on('error', function (e) {
      log('端口 ' + port + ' 监听失败: ' + e.code);
    });
    srv.listen(port, function () {
      log('监听活跃检测端口 ' + port);
    });
    servers.push(srv);
  }

  function fireShutdown() {
    if (fired) return; // 只触发一次,防止重复执行
    fired = true;
    log('空闲 ' + (idleMinutes) + ' 分钟无访问,触发关机');
    if (dryRun) {
      log('DRY-RUN: 跳过真实关机(命令: ' + shutdownCmd + ')');
      return;
    }
    const parts = String(shutdownCmd).trim().split(/\s+/);
    const child = spawn(parts[0], parts.slice(1), { stdio: 'inherit' });
    child.on('error', function (e) {
      log('关机命令执行失败: ' + e.message);
      fired = false; // 允许重试
    });
  }

  const timer = setInterval(function () {
    let active = false;
    if (watchPorts.length > 0) {
      const ports = scanEstablishedPorts();
      active = watchPorts.some(function (p) { return ports.has(p); });
      if (active) touch();
    }
    const idle = Date.now() - lastActive;
    if (!active && idle >= idleMs) {
      if (!stopping) fireShutdown();
    }
  }, Math.max(checkIntervalSec * 1000, 500));

  log('空闲关机守护启动: 空闲阈值 ' + idleMinutes + ' 分钟, 扫描间隔 ' + checkIntervalSec + 's' +
      (watchPorts.length ? ', 监视端口 ' + watchPorts.join(',') : '') +
      (listenPorts.length ? ', 监听端口 ' + listenPorts.join(',') : '') +
      (dryRun ? ', DRY-RUN 模式' : ''));

  // ---- 状态/控制 HTTP 端点(可选,cfg.heavy.statusPort > 0)----
  // GET  /                  状态 JSON(供管理面板轮询:空闲倒计时/监视端口/触发状态)
  // POST /_heavy/shutdown   手动触发关机(面板按钮;dry-run 模式只打日志)
  let statusServer = null;
  if (cfg.heavy.statusPort > 0) {
    statusServer = http.createServer(function (req, res) {
      const url = req.url || '/';
      if (url === '/_heavy/shutdown' && req.method === 'POST') {
        log('手动触发关机(来自管理面板)');
        fireShutdown();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ fired: fired, dryRun: dryRun }));
        return;
      }
      const idleRemainSec = Math.max(0, Math.round((idleMs - (Date.now() - lastActive)) / 1000));
      const body = JSON.stringify({
        name: 'heavy', online: true, dryRun: dryRun,
        watchPorts: watchPorts, listenPorts: listenPorts,
        idleMinutes: idleMinutes, checkIntervalSec: checkIntervalSec,
        shutdownCmd: shutdownCmd,
        lastActive: new Date(lastActive).toISOString(),
        idleRemainSec: idleRemainSec,
        fired: fired
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    });
    statusServer.listen(cfg.heavy.statusPort, '0.0.0.0', function () {
      log('状态端点 http://0.0.0.0:' + cfg.heavy.statusPort + '/');
    });
  }

  return {
    stop: function () {
      stopping = true;
      clearInterval(timer);
      servers.forEach(function (s) { try { s.close(); } catch (e) {} });
      if (statusServer) { try { statusServer.close(); } catch (e) {} }
    },
    status: function () {
      return {
        idleMs: idleMs,
        lastActive: lastActive,
        fired: fired
      };
    }
  };
}

module.exports = { createSleepServer, scanEstablishedPorts };
