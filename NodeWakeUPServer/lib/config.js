'use strict';
// NodeWakeUPServer 配置加载与校验

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  proxy: {
    host: '0.0.0.0',         // 代理监听地址
    probeTimeoutMs: 800,     // 后端 TCP 探测超时
    wakeTimeoutSec: 180,     // 唤醒后等待后端上线的最长秒数
    wakeRetries: 5,          // WOL 最大重发轮数
    wakeIntervalMs: 1500,    // 每轮 WOL 间隔
    statusPort: 9090,        // 管理面板/诊断端点端口(0 = 关闭)
    routes: []               // 路由表,见 config.example.json
  }
};

const ROUTE_DEFAULTS = {
  wol: {
    mac: '',                 // 必填:唤醒目标网卡 MAC(用户自行填写),如 AA:BB:CC:DD:EE:FF
    broadcast: '255.255.255.255', // WOL 广播地址(跨网段需配置定向广播)
    ports: [7, 9]            // WOL 发送端口,默认 7 和 9
  }
};

const MAC_RE = /^[0-9a-fA-F]{12}$/;

function loadConfig(file) {
  const p = path.resolve(file || 'config.json');
  let raw = {};
  if (fs.existsSync(p)) {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const cfg = {
    proxy: Object.assign({}, DEFAULTS.proxy, raw.proxy || {})
  };

  const routes = [];
  const rawRoutes = Array.isArray(cfg.proxy.routes) ? cfg.proxy.routes : [];
  for (const r of rawRoutes) {
    const route = Object.assign({}, r);
    route.wol = Object.assign({}, ROUTE_DEFAULTS.wol, r.wol || {});
    routes.push(validateRoute(route));
  }
  cfg.proxy.routes = routes;

  if (cfg.proxy.routes.length === 0) {
    throw new Error('配置错误: 至少需要配置一条 proxy.routes 路由');
  }
  return cfg;
}

function validateRoute(r) {
  if (!Number.isInteger(r.listenPort) || r.listenPort < 1 || r.listenPort > 65535) {
    throw new Error('route.listenPort 必须是 1-65535 的整数');
  }
  // 后端定位二选一:
  //   backend    : 静态 host:port(IP 固定时用)
  //   backendMac : 后端服务器网卡 MAC + backendPort,运行时经 ARP 反查当前 IP(适配 DHCP 动态 IP)
  const hasStatic = typeof r.backend === 'string' && r.backend.length > 0;
  const hasMac = typeof r.backendMac === 'string' && r.backendMac.length > 0;
  if (!hasStatic && !hasMac) {
    throw new Error('route 必须配置 backend(静态 host:port)或 backendMac(通过 MAC 反查动态 IP)之一');
  }
  if (hasStatic) {
    if (!/^[^:]+:\d{1,5}$/.test(r.backend)) {
      throw new Error('route.backend 格式应为 host:port,如 192.168.1.100:8080');
    }
  } else {
    const mac = String(r.backendMac).replace(/[^0-9a-fA-F]/g, '');
    if (!MAC_RE.test(mac)) {
      throw new Error('route.backendMac 格式错误,应为 AA:BB:CC:DD:EE:FF');
    }
    if (!Number.isInteger(r.backendPort) || r.backendPort < 1 || r.backendPort > 65535) {
      throw new Error('route 使用 backendMac 时必须同时配置 backendPort(1-65535)');
    }
  }
  const mac = String(r.wol.mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (!MAC_RE.test(mac)) {
    throw new Error('route.wol.mac 必填且格式应为 AA:BB:CC:DD:EE:FF(唤醒网卡 MAC,由用户填写)');
  }
  if (!Array.isArray(r.wol.ports) || r.wol.ports.length === 0) {
    r.wol.ports = [7, 9];
  }
  return r;
}

function splitHostPort(hostport) {
  // 支持 host:port 与 [ipv6]:port
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(hostport) || /^([^:]+):(\d+)$/.exec(hostport);
  return m ? { host: m[1], port: parseInt(m[2], 10) } : { host: hostport, port: null };
}

module.exports = { loadConfig, splitHostPort, DEFAULTS };
