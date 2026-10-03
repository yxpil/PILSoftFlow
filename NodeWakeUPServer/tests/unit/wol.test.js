'use strict';
/**
 * lib/wol.js 魔法包生成单元测试（不真正发 UDP，只验证包结构）
 */
const test = require('node:test');
const assert = require('node:assert');
const { magicPacket } = require('../../lib/wol');

test('合法 MAC → 102 字节：6 个 0xFF + MAC 重复 16 次', () => {
  const pkt = magicPacket('AA:BB:CC:DD:EE:FF');
  assert.strictEqual(pkt.length, 102);
  for (let i = 0; i < 6; i++) assert.strictEqual(pkt[i], 0xff);
  const mac = Buffer.from('aabbccddeeff', 'hex');
  for (let rep = 0; rep < 16; rep++) {
    assert.ok(mac.equals(pkt.slice(6 + rep * 6, 12 + rep * 6)), '第 ' + rep + ' 段应为 MAC');
  }
});

test('MAC 分隔符被忽略（冒号/短横都可）', () => {
  const a = magicPacket('aa-bb-cc-dd-ee-ff');
  const b = magicPacket('aabbccddeeff');
  assert.ok(a.equals(b));
});

test('注入/边界：非法 MAC（长度不对）抛错，不静默发错包', () => {
  assert.throws(() => magicPacket(''), /MAC 格式错误/);
  assert.throws(() => magicPacket('ZZ:YY:XX:VV:UU:TT'), /MAC 格式错误/); // 非 hex
  assert.throws(() => magicPacket('aabbcc'), /MAC 格式错误/); // 太短
});
