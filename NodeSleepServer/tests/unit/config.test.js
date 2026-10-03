'use strict';
/**
 * lib/config.js 配置校验单元测试
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, DEFAULTS } = require('../../lib/config');

function writeTmp(obj) {
  const f = path.join(os.tmpdir(), 'pilsoftflow-sleep-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('无配置文件且无端口 → 抛错', () => {
  assert.throws(() => loadConfig(path.join(os.tmpdir(), 'pilsoftflow-not-exist.json')), /至少需要配置/);
});

test('默认值合并 + watchPorts 校验通过', () => {
  const f = writeTmp({ heavy: { watchPorts: [8080, 8081] } });
  const cfg = loadConfig(f);
  assert.deepStrictEqual(cfg.heavy.watchPorts, [8080, 8081]);
  assert.strictEqual(cfg.heavy.idleMinutes, DEFAULTS.heavy.idleMinutes);
  assert.strictEqual(cfg.heavy.checkIntervalSec, DEFAULTS.heavy.checkIntervalSec);
});

test('listenPorts 模式也可通过校验', () => {
  const f = writeTmp({ heavy: { listenPorts: [9000] } });
  assert.deepStrictEqual(loadConfig(f).heavy.listenPorts, [9000]);
});

test('非法参数逐一报错', () => {
  assert.throws(() => loadConfig(writeTmp({ heavy: { watchPorts: [1], idleMinutes: 0 } })), /idleMinutes/);
  assert.throws(() => loadConfig(writeTmp({ heavy: { watchPorts: [1], checkIntervalSec: -1 } })), /checkIntervalSec/);
});

test('watchPorts 非数组被收敛为空数组', () => {
  const f = writeTmp({ heavy: { watchPorts: 'notarray', listenPorts: [1] } });
  assert.deepStrictEqual(loadConfig(f).heavy.watchPorts, []);
});
