#!/usr/bin/env node
'use strict';
// NodeSleepServer - 重型服务器端(空闲自动关机守护)
//
// 用法:
//   node server.js start [--config config.json] [--dry-run]   启动守护(--dry-run 不真关机)
//
// 两种活跃检测模式(可同时启用,任一活跃即重置计时):
//   watchPorts  : Linux 生产模式。周期性扫描 /proc/net/tcp(+tcp6),
//                 若任一业务端口存在 ESTABLISHED 连接则视为活跃。
//                 不占用业务端口,与真实服务共存。
//   listenPorts : 占用端口模式(测试/无真实服务场景),连接即活跃。
//
// 空闲超过 idleMinutes -> 执行 shutdownCmd。可选 statusPort 提供状态/控制 HTTP 端点。

const { loadConfig } = require('./lib/config');
const { log } = require('./lib/util');
const { createSleepServer } = require('./lib/sleep');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '-c' || a === '--config') { out.config = argv[++i]; continue; }
  }
  return out;
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (cmd === 'start') {
  const cfg = loadConfig(args.config);
  const server = createSleepServer(cfg, { log: log.bind(null, 'sleep'), dryRun: args.dryRun });
  process.on('SIGTERM', function () { server.stop(); process.exit(0); });
  process.on('SIGINT', function () { server.stop(); process.exit(0); });
  log('sleep 守护运行中 (Ctrl+C 退出)');
} else {
  console.error('用法: node server.js start [--config config.json] [--dry-run]');
  console.error('  start : 启动空闲自动关机守护(--dry-run 只打日志不真关机)');
  process.exit(1);
}
