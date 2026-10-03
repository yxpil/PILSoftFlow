'use strict';
/**
 * lib/arp.js ARP 表解析单元测试
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseLinuxArp, parseWindowsArp, normalizeMac } = require('../../lib/arp');

const LINUX = [
  'IP address       HW type     Flags       HW address            Mask     Device',
  '192.168.1.100    0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0',
  '192.168.1.101    0x1         0x0         11:22:33:44:55:66     *        eth0',
  '0.0.0.0          0x1         0x2         00:00:00:00:00:00     *        eth0'
].join('\n');

test('Linux ARP：complete(flags 0x2) 命中返回 IP，incomplete/0.0.0.0/全零 MAC 跳过', () => {
  assert.strictEqual(parseLinuxArp(LINUX, 'aabbccddeeff'), '192.168.1.100');
  assert.strictEqual(parseLinuxArp(LINUX, '112233445566'), null, 'flags=0x0 应跳过');
  assert.strictEqual(parseLinuxArp(LINUX, 'ffffffffffff'), null);
});

const WINDOWS = [
  'Interface: 192.168.1.50 --- 0x5',
  '  Internet Address      Physical Address      Type',
  '  192.168.1.100         aa-bb-cc-dd-ee-ff     dynamic',
  '  some random text line',
  '  192.168.1.102         00-00-00-00-00-00     dynamic'
].join('\n');

test('Windows arp -a：命中返回 IP，非 IP 行与全零 MAC 跳过', () => {
  assert.strictEqual(parseWindowsArp(WINDOWS, 'aabbccddeeff'), '192.168.1.100');
  assert.strictEqual(parseWindowsArp(WINDOWS, '000000000000'), null, '全零 MAC 跳过');
  assert.strictEqual(parseWindowsArp(WINDOWS, '1234567890ab'), null);
});

test('normalizeMac：去分隔符转小写', () => {
  assert.strictEqual(normalizeMac('AA-Bb:Cc:Dd:Ee:Ff'), 'aabbccddeeff');
  assert.strictEqual(normalizeMac(''), '');
});
