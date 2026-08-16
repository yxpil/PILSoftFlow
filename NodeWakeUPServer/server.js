#!/usr/bin/env node
'use strict';
// NodeWakeUPServer - 分代理服务器端(WOL 唤醒代理)
//
// 用法:
//   node server.js start [--config config.json]   启动唤醒代理
//   node server.js wake  --mac AA:BB:CC:DD:EE:FF [--broadcast 192.168.1.255] [--ports 7,9]
//                                                  手动发送 WOL 魔法包

const { loadConfig } = require('./lib/config');
const { log } = require('./lib/util');
const { createProxy } = require('./lib/proxy');
const { sendWol, magicPacket } = require('./lib/wol');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') { out.config = argv[++i]; continue; }
    if (a === '--mac') { out.mac = argv[++i]; continue; }
    if (a === '--broadcast') { out.broadcast = argv[++i]; continue; }
    if (a === '--ports') { out.ports = String(argv[++i]).split(',').map(Number); continue; }
  }
  return out;
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (cmd === 'start') {
  const cfg = loadConfig(args.config);
  const proxy = createProxy(cfg, { log: log.bind(null, 'wakeup') });
  process.on('SIGTERM', function () { proxy.stop(); process.exit(0); });
  process.on('SIGINT', function () { proxy.stop(); process.exit(0); });
  log('wakeup 代理运行中 (Ctrl+C 退出)');
} else if (cmd === 'wake') {
  if (!args.mac) {
    console.error('用法: node server.js wake --mac AA:BB:CC:DD:EE:FF [--broadcast 192.168.1.255] [--ports 7,9]');
    process.exit(1);
  }
  magicPacket(args.mac); // 校验 MAC 格式
  sendWol({
    mac: args.mac,
    broadcast: args.broadcast || '255.255.255.255',
    ports: args.ports && args.ports.length ? args.ports : [7, 9]
  }, log.bind(null, 'wol')).then(function (ok) {
    process.exit(ok > 0 ? 0 : 1);
  });
} else {
  console.error('用法: node server.js <start|wake> [选项]');
  console.error('  start : 启动 WOL 唤醒代理(分代理服务器端)');
  console.error('  wake  : 手动发送 WOL 魔法包');
  process.exit(1);
}
