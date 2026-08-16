'use strict';
// NodeSleepServer 配置加载与校验

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  heavy: {
    watchPorts: [],          // Linux 生产模式:扫描 /proc/net/tcp 的业务端口(不占用端口)
    listenPorts: [],         // 测试/占用端口模式:直接监听,连接即活跃
    idleMinutes: 5,          // 空闲多少分钟无访问 -> 关机
    checkIntervalSec: 30,    // 活跃状态扫描周期
    shutdownCmd: 'systemctl poweroff', // 触发关机的命令(可改成 poweroff 等)
    statusPort: 0            // 状态/控制 HTTP 端点端口(0 = 关闭,供管理面板查询)
  }
};

function loadConfig(file) {
  const p = path.resolve(file || 'config.json');
  let raw = {};
  if (fs.existsSync(p)) {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const cfg = {
    heavy: Object.assign({}, DEFAULTS.heavy, raw.heavy || {})
  };
  if (!Array.isArray(cfg.heavy.watchPorts)) cfg.heavy.watchPorts = [];
  if (!Array.isArray(cfg.heavy.listenPorts)) cfg.heavy.listenPorts = [];

  const errors = [];
  if (cfg.heavy.watchPorts.length === 0 && cfg.heavy.listenPorts.length === 0) {
    errors.push('至少需要配置 heavy.watchPorts(监视业务端口)或 heavy.listenPorts(占用端口模式)之一');
  }
  if (cfg.heavy.idleMinutes <= 0) errors.push('heavy.idleMinutes 必须大于 0');
  if (cfg.heavy.checkIntervalSec <= 0) errors.push('heavy.checkIntervalSec 必须大于 0');
  if (errors.length) {
    throw new Error('配置错误:\n  - ' + errors.join('\n  - '));
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
