'use strict';
/**
 * lib/sleep.js scanEstablishedPorts 单元测试 —— 解析 /proc/net/tcp。
 * 注入假的 readFileSync，验证只收集 ESTABLISHED(01) 的十六进制端口。
 */
const test = require('node:test');
const assert = require('node:assert');
const { scanEstablishedPorts } = require('../../lib/sleep');

// 典型 /proc/net/tcp 片段：local_address = 0100007F:1F90 (127.0.0.1:8080)
const TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345',
  '   1: 0100007F:1F91 0100007F:1234 01 00000000:00000000 00:00000000 00000000     0        0 12346',
  '   2: 0100007F:1F92 0100007F:5678 06 00000000:00000000 00:00000000 00000000     0        0 12347',
  '   3: MALFORMED LINE',
  ''
].join('\n');

test('只收集 ESTABLISHED(st=01) 的端口，十六进制转十进制', () => {
  const readFileSync = (f) => { if (f === '/proc/net/tcp') return TCP; throw new Error('enoent'); };
  const ports = scanEstablishedPorts({ readFileSync, files: ['/proc/net/tcp'] });
  assert.ok(ports instanceof Set);
  assert.ok(ports.has(0x1F91), 'st=01 的 8081 应被收集');
  assert.ok(!ports.has(0x1F90), 'st=0A(LISTEN) 不应收集');
  assert.ok(!ports.has(0x1F92), 'st=06(TIME_WAIT) 不应收集');
});

test('文件不可读时安全跳过，返回空集合', () => {
  const readFileSync = () => { throw new Error('enoent'); };
  const ports = scanEstablishedPorts({ readFileSync, files: ['/proc/net/tcp'] });
  assert.strictEqual(ports.size, 0);
});

test('同时合并 tcp 与 tcp6', () => {
  const readFileSync = (f) => f === '/proc/net/tcp'
    ? 'sl\n 0: 0100007F:1F90 00000000:0000 01 x\n'
    : 'sl\n 0: 0100007F:1F93 00000000:0000 01 x\n';
  const ports = scanEstablishedPorts({ readFileSync, files: ['/proc/net/tcp', '/proc/net/tcp6'] });
  assert.ok(ports.has(0x1F90) && ports.has(0x1F93));
});
