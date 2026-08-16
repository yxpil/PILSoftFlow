'use strict';
// 分代理服务器端:WOL 唤醒代理
//
// 每条路由:
//   收到连接 -> 探测后端是否在线(backendMac 场景经 ARP 反查当前 IP)
//     在线  -> 直接双向透传
//     离线  -> 发送 WOL 魔法包(UDP 7/9)唤醒重型服务器
//              HTTP 请求 -> 返回"正在唤醒"页(meta refresh 自动刷新)
//              其他协议  -> 保持连接,周期探测,后端就绪后自动透传
//
// 诊断端点(默认 http://host:9090):
//   GET /_wol/status          各路由后端在线状态
//   GET /_wol/wake?route=80   手动触发指定路由唤醒
//
// 连接模型(数据收集器):
//   连接建立后立即注册 data 监听(流进入流动模式,数据永不丢失,统一收入 pending 缓冲)。
//   首块数据一到立即做 HTTP 识别 -> 回唤醒页;非 HTTP -> 保持收集,唤醒循环探测后端。
//   后端就绪后手动转发:先 flush pending,再双向转发,避免 pause/resume 与
//   probe(ECONNREFUSED 毫秒级返回,快于 HTTP 数据到达)的竞态吞掉识别。

const net = require('net');
const http = require('http');
const { sendWol } = require('./wol');
const { splitHostPort } = require('./config');
const { createResolver } = require('./arp');
const { sleep } = require('./util');

const WAKE_PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta http-equiv="refresh" content="3">',
  '<title>正在唤醒服务器</title>',
  '<style>',
  '  body{background:#fafafa;font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;',
  '       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#111;}',
  '  .card{background:#fff;border:1px solid #e6e6e6;border-radius:22px;padding:48px 56px;',
  '        text-align:center;max-width:420px;}',
  '  .dot{width:14px;height:14px;border-radius:50%;background:#111;margin:0 auto 22px;',
  '       animation:pulse 1.2s ease-in-out infinite;}',
  '  @keyframes pulse{0%,100%{opacity:.25;transform:scale(.85);}50%{opacity:1;transform:scale(1);}}',
  '  h1{font-size:18px;font-weight:600;margin:0 0 10px;letter-spacing:.5px;}',
  '  p{font-size:13px;color:#777;margin:0;line-height:1.8;}',
  '  .chip{display:inline-block;margin-top:22px;padding:6px 16px;border-radius:999px;',
  '        background:#111;color:#fff;font-size:12px;letter-spacing:1px;}',
  '</style>',
  '</head>',
  '<body>',
  '<div class="card">',
  '  <div class="dot"></div>',
  '  <h1>正在唤醒服务器</h1>',
  '  <p>目标服务器已进入休眠,正在发送唤醒信号<br>请稍候,页面将自动重试...</p>',
  '  <span class="chip">WOL 唤醒中</span>',
  '</div>',
  '</body>',
  '</html>'
].join('\n');

// 管理面板页面(简约黑白圆角胶囊,无 emoji)
// __HEAVY_URLS__ 占位符由服务端替换为重型服务器端状态端点列表
const PANEL_PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>waked 服务器状态</title>',
  '<style>',
  '  body{background:#fafafa;font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;margin:0;color:#111;padding:32px;}',
  '  h1{font-size:20px;font-weight:600;letter-spacing:1px;margin:0 0 4px;}',
  '  .sub{font-size:12px;color:#999;margin:0 0 24px;letter-spacing:.5px;}',
  '  .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:1100px;}',
  '  @media(max-width:860px){.grid{grid-template-columns:1fr;}}',
  '  .col{background:#fff;border:1px solid #e6e6e6;border-radius:22px;padding:20px;}',
  '  .col h2{font-size:13px;font-weight:600;letter-spacing:1px;margin:0 0 14px;display:flex;align-items:center;gap:8px;}',
  '  .node-dot{width:8px;height:8px;border-radius:50%;background:#ccc;display:inline-block;}',
  '  .node-dot.on{background:#111;}',
  '  .card{border:1px solid #eee;border-radius:16px;padding:14px 16px;margin-bottom:12px;}',
  '  .card .row{display:flex;justify-content:space-between;align-items:center;gap:8px;}',
  '  .card .name{font-size:14px;font-weight:600;}',
  '  .card .meta{font-size:12px;color:#777;margin-top:6px;line-height:1.7;}',
  '  .chip{display:inline-block;padding:3px 12px;border-radius:999px;font-size:11px;letter-spacing:.5px;background:#f0f0f0;color:#777;}',
  '  .chip.on{background:#111;color:#fff;}',
  '  .chip.waking{background:#111;color:#fff;animation:pulse 1.2s ease-in-out infinite;}',
  '  @keyframes pulse{0%,100%{opacity:.35;}50%{opacity:1;}}',
  '  .btn{display:inline-block;padding:6px 16px;border-radius:999px;border:1px solid #111;background:#111;color:#fff;font-size:12px;cursor:pointer;letter-spacing:.5px;}',
  '  .kv{display:flex;justify-content:space-between;font-size:12px;color:#777;padding:3px 0;}',
  '</style>',
  '</head>',
  '<body>',
  '<h1>waked 服务器状态</h1>',
  '<p class="sub">自动关机 + WOL 唤醒 · 分代理服务器 / 重型服务器端</p>',
  '<div class="grid">',
  '  <div class="col">',
  '    <h2><span class="node-dot" id="proxyDot"></span>分代理服务器</h2>',
  '    <div id="routes"></div>',
  '  </div>',
  '  <div class="col">',
  '    <h2><span class="node-dot" id="heavyDot"></span>重型服务器端</h2>',
  '    <div id="heavyCards"></div>',
  '  </div>',
  '</div>',
  '<script>',
  '  var HEAVY_URLS = __HEAVY_URLS__;',
  '  var HSHUT = HEAVY_URLS.length ? HEAVY_URLS[0].url.replace(/\\/$/,"") + "/_heavy/shutdown" : "";',
  '  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
  '  function chip(text, cls){return "<span class=\\"chip " + cls + "\\">" + text + "</span>";}',
  '  function load(){',
  '    fetch("/_wol/status").then(function(r){return r.json();}).then(function(d){',
  '      document.getElementById("proxyDot").className="node-dot on";',
  '      var html="";',
  '      d.routes.forEach(function(s){',
  '        var now=Date.now();',
  '        var waking = !s.online && s.lastWakeAt && (now-new Date(s.lastWakeAt).getTime()) < 30000;',
  '        var st = s.online ? "在线" : (waking ? "正在唤醒" : "离线");',
  '        var cls = s.online ? "on" : (waking ? "waking" : "");',
  '        html += "<div class=\\"card\\"><div class=\\"row\\"><span class=\\"name\\">" + esc(s.name) + "</span>" + chip(st, cls) + "</div>";',
  '        html += "<div class=\\"meta\\">监听 :" + s.listenPort + " → " + esc(s.backend) + "<br>当前IP: " + esc(s.currentIp || "—") + " · WOL x" + s.wolCount + " · 连接 x" + s.connections + "</div>";',
  '        html += "<div style=\\"margin-top:10px;\\"><button class=\\"btn\\" onclick=\\"wake(" + s.listenPort + ")\\">发送唤醒</button></div></div>";',
  '      });',
  '      document.getElementById("routes").innerHTML = html || "<div class=\\"meta\\">无路由配置</div>";',
  '    }).catch(function(){document.getElementById("proxyDot").className="node-dot";});',
  '    var box=document.getElementById("heavyCards");',
  '    if(!HEAVY_URLS.length){box.innerHTML="<div class=\\"meta\\">未配置重型服务器端状态端点<br>(route.heavyStatusUrl)</div>";return;}',
  '    fetch(HEAVY_URLS[0].url).then(function(r){return r.json();}).then(function(s){',
  '      document.getElementById("heavyDot").className="node-dot on";',
  '      box.innerHTML="<div class=\\"card\\"><div class=\\"row\\"><span class=\\"name\\">" + esc(s.name) + "</span>" + chip("在线", "on") + "</div>"',
  '        + "<div class=\\"kv\\"><span>监视端口</span><span>" + esc((s.watchPorts||[]).join(",") || "—") + "</span></div>"',
  '        + "<div class=\\"kv\\"><span>空闲阈值</span><span>" + s.idleMinutes + " 分钟</span></div>"',
  '        + "<div class=\\"kv\\"><span>关机倒计时</span><span>" + s.idleRemainSec + "s</span></div>"',
  '        + "<div class=\\"kv\\"><span>已触发关机</span><span>" + (s.fired ? "是" : "否") + "</span></div>"',
  '        + "<div style=\\"margin-top:10px;\\"><button class=\\"btn\\" onclick=\\"heavyShutdown()\\">触发关机</button></div></div>";',
  '    }).catch(function(){',
  '      document.getElementById("heavyDot").className="node-dot";',
  '      box.innerHTML="<div class=\\"card\\"><div class=\\"row\\"><span class=\\"name\\">" + esc(HEAVY_URLS[0].name) + "</span>" + chip("离线/未连接", "") + "</div><div class=\\"meta\\">" + esc(HEAVY_URLS[0].url) + "</div></div>";',
  '    });',
  '  }',
  '  function wake(port){fetch("/_wol/wake?route=" + port).then(function(){setTimeout(load, 600);});}',
  '  function heavyShutdown(){if(HSHUT){fetch(HSHUT,{method:"POST"}).then(function(){setTimeout(load, 600);});}}',
  '  setInterval(load, 2000);',
  '  load();',
  '</script>',
  '</body>',
  '</html>'
].join('\n');

// TCP 探测:target 在 timeoutMs 内能建立连接即视为在线;target 为 null 视为离线
function probe(target, timeoutMs) {
  if (!target || !target.port) return Promise.resolve(false);
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (ok) {
      if (!done) { done = true; sock.destroy(); resolve(ok); }
    };
    const sock = net.connect({ host: target.host, port: target.port });
    sock.setTimeout(Math.max(timeoutMs, 100), function () { finish(false); });
    sock.once('connect', function () { finish(true); });
    sock.once('error', function () { finish(false); });
  });
}

// 手动双向透传:先 flush 唤醒期间缓冲的 pending,再双向转发
function tunnelManual(client, bsock, pending) {
  client.on('error', function () { bsock.destroy(); });
  bsock.on('error', function () { client.destroy(); });
  client.on('end', function () { bsock.end(); });
  bsock.on('end', function () { client.end(); });
  client.on('data', function (d) { bsock.write(d); });
  bsock.on('data', function (d) { client.write(d); });
  while (pending.length) bsock.write(pending.shift());
}

function connectBackend(target) {
  if (!target || !target.port) return Promise.resolve(null);
  return new Promise(function (resolve) {
    const sock = net.connect({ host: target.host, port: target.port });
    sock.once('connect', function () { resolve(sock); });
    sock.once('error', function () { resolve(null); });
  });
}

// 首块数据是否像 HTTP 请求(用于决定回唤醒页还是保持连接轮询)
function looksLikeHttp(buf) {
  return /^[A-Za-z]+[ \t]+\S+[ \t]+HTTP\/\d/.test(buf.toString('latin1'));
}

function createProxy(cfg, opts) {
  const log = opts.log;
  const arpResolver = opts.arpResolver || createResolver(); // 可注入(测试用)
  const pcfg = cfg.proxy;
  const state = new Map(); // listenPort -> { online, lastWakeAt, wolCount, connections }

  // 解析后端目标:
  //   backend    : 静态 host:port,直接返回
  //   backendMac : 经 ARP 反查 MAC 当前 IP(DHCP 动态 IP 场景,每次调用实时解析)
  //   解析不到    : 返回 null(视为离线)
  function backendTarget(route) {
    if (route.backend) return splitHostPort(route.backend);
    const ip = arpResolver(route.backendMac || route.wol.mac);
    return ip ? { host: ip, port: route.backendPort } : null;
  }

  function targetHostPort(target) {
    return target ? target.host + ':' + target.port : '(ARP 未解析)';
  }

  // ---- 每条路由的 TCP 代理 ----
  const servers = [];
  for (const route of pcfg.routes) {
    const st = {
      name: route.name || ('route:' + route.listenPort),
      backend: route.backend || (route.backendMac + ':' + route.backendPort),
      listenPort: route.listenPort,
      online: false,
      lastWakeAt: null,
      wolCount: 0,
      connections: 0,
      probeOk: 0,
      probeFail: 0,
      currentIp: null
    };
    state.set(route.listenPort, st);

    const srv = net.createServer(function (client) {
      handleConnection(client, route, st);
    });
    srv.on('error', function (e) {
      log('路由端口 ' + route.listenPort + ' 监听失败: ' + e.code);
    });
    srv.listen(route.listenPort, pcfg.host, function () {
      const targetDesc = route.backend ? route.backend : ('MAC ' + route.backendMac + ':' + route.backendPort + ' (ARP 动态解析)');
      log('路由 [' + (route.name || route.listenPort) + '] 监听 ' + pcfg.host + ':' + route.listenPort +
          ' -> ' + targetDesc + ' (WOL ' + route.wol.mac + ' @ ' + route.wol.broadcast + ':' + route.wol.ports.join(',') + ')');
    });
    servers.push(srv);

    // 周期探测,维护在线状态(供诊断端点显示)
    setInterval(function () {
      const target = backendTarget(route);
      if (target) st.currentIp = target.host;
      probe(target, pcfg.probeTimeoutMs).then(function (up) {
        st.online = up;
        if (up) st.probeOk++; else st.probeFail++;
      });
    }, 5000);
  }

  // ---- 单连接处理 ----
  // 数据收集器模型:注册 data 监听即进入流动模式,数据统一缓冲到 pending,
  // 首块一到立即 HTTP 识别,彻底规避 pause/resume 与 probe 毫秒级返回的竞态。
  function handleConnection(client, route, st) {
    st.connections++;
    client.setNoDelay(true);
    client.on('error', function () {});

    const pending = [];
    let mode = null; // null | 'tunnel' | 'wake-tunnel' | 'wake-page'
    let firstBytes = null;
    const ctl = { cancelled: false }; // 终止唤醒循环的令牌

    const collector = function (chunk) {
      pending.push(chunk);
      if (mode === 'tunnel' || mode === 'wake-page') return;
      if (!firstBytes) {
        firstBytes = chunk;
        // 唤醒循环中,数据后到且是 HTTP -> 改判回页(如 SSH 场景客户端先说话)
        if (mode === 'wake-tunnel' && looksLikeHttp(chunk)) {
          ctl.cancelled = true;
          mode = 'wake-page';
          respondWakePage(client, route);
          wakeInBackground(route, st, log);
        }
      }
    };
    client.on('data', collector);

    // 决策统一收敛在 probe 返回处:在线透传 / 离线按首块数据分流。
    // (数据先到只进 pending 缓冲,不立即决策,避免在线误判 503)
    probe(backendTarget(route), pcfg.probeTimeoutMs).then(function (up) {
      if (up) {
        st.online = true;
        if (mode === 'wake-page' || mode === 'wake-tunnel') return; // 已有决策
        mode = 'tunnel';
        connectBackend(backendTarget(route)).then(function (bsock) {
          if (!bsock) { client.destroy(); return; }
          if (client.destroyed) { bsock.destroy(); return; }
          client.removeListener('data', collector);
          tunnelManual(client, bsock, pending);
        });
      } else {
        // 后端离线 -> 分流:已有 HTTP 数据回页;否则进入唤醒循环
        st.online = false;
        if (mode === 'wake-page' || mode === 'wake-tunnel') return; // 已有决策
        mode = 'wake-tunnel';
        if (firstBytes && looksLikeHttp(firstBytes)) {
          mode = 'wake-page';
          respondWakePage(client, route);
          wakeInBackground(route, st, log);
          return;
        }
        wakeAndTunnel(client, pending, route, st, ctl, collector);
      }
    });
  }

  // HTTP 唤醒页响应
  function respondWakePage(client, route) {
    const body = Buffer.from(WAKE_PAGE, 'utf8');
    const head = [
      'HTTP/1.1 503 Service Unavailable',
      'Content-Type: text/html; charset=utf-8',
      'Content-Length: ' + body.length,
      'Retry-After: 3',
      'Connection: close',
      'X-WOL-Status: waking',
      '',
      ''
    ].join('\r\n');
    client.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    client.end();
  }

  // 后台持续发 WOL(HTTP 场景:页面已经返回,唤醒信号在后台发;1 秒内节流防刷包)
  function wakeInBackground(route, st, log) {
    const last = st.lastWakeAt ? Date.parse(st.lastWakeAt) : 0;
    if (Date.now() - last < 1000) return;
    doWake(route, st, log).catch(function () {});
  }

  // 非 HTTP:连接保持,循环 探测 -> 发 WOL -> 等后端上线后透传。
  // 每次循环重新解析后端目标(backendMac 场景:DHCP 换 IP 也能跟上)。
  // ctl.cancelled 被 HTTP 分支置位后静默退出,交由回页逻辑处理。
  async function wakeAndTunnel(client, pending, route, st, ctl, collector) {
    const deadline = Date.now() + pcfg.wakeTimeoutSec * 1000;
    let wolSent = 0;
    let lastIp = null;
    while (!client.destroyed && !ctl.cancelled && Date.now() < deadline) {
      const target = backendTarget(route);
      if (target && target.host !== lastIp) {
        lastIp = target.host;
        log('后端目标: ' + targetHostPort(target));
      }
      const up = await probe(target, pcfg.probeTimeoutMs);
      if (up) {
        st.online = true;
        const bsock = await connectBackend(target);
        if (!bsock) continue;
        if (client.destroyed) { bsock.destroy(); return; }
        client.removeListener('data', collector);
        log('后端 [' + targetHostPort(target) + '] 已上线,连接透传');
        tunnelManual(client, bsock, pending);
        return;
      }
      if (wolSent < pcfg.wakeRetries) {
        const ok = await doWake(route, st, log);
        if (ok > 0) wolSent++;
      }
      await sleep(pcfg.wakeIntervalMs);
    }
    if (ctl.cancelled) return; // 已改判回页,静默退出
    log('唤醒超时(' + pcfg.wakeTimeoutSec + 's),关闭连接');
    client.destroy();
  }

  // 发送一轮 WOL 并记录状态
  async function doWake(route, st, log) {
    const ok = await sendWol(route.wol, log);
    if (ok > 0) {
      st.lastWakeAt = new Date().toISOString();
      st.wolCount++;
    }
    return ok;
  }

  // ---- 诊断 HTTP 端点 ----
  const statusServer = http.createServer(function (req, res) {
    const url = req.url || '/';
    if (url === '/') {
      // 管理面板:聚合显示分代理服务器路由状态 + 重型服务器端状态
      const heavyUrls = pcfg.routes
        .filter(function (r) { return r.heavyStatusUrl; })
        .map(function (r) { return { name: r.name || ('route:' + r.listenPort), url: r.heavyStatusUrl }; });
      const page = PANEL_PAGE.replace('__HEAVY_URLS__', JSON.stringify(heavyUrls));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (url === '/_wol/status') {
      const body = JSON.stringify({
        time: new Date().toISOString(),
        routes: Array.from(state.values()).map(function (s) {
          return {
            name: s.name, listenPort: s.listenPort, backend: s.backend,
            online: s.online, lastWakeAt: s.lastWakeAt, wolCount: s.wolCount,
            connections: s.connections, probeOk: s.probeOk, probeFail: s.probeFail,
            currentIp: s.currentIp
          };
        })
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url.startsWith('/_wol/wake')) {
      const q = new URL(url, 'http://x').searchParams;
      const port = parseInt(q.get('route') || q.get('port') || '', 10);
      const st2 = state.get(port);
      if (!st2) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'route not found: ' + port }));
        return;
      }
      const route = pcfg.routes.find(function (r) { return r.listenPort === port; });
      sendWol(route.wol, log).then(function (ok) {
        if (ok > 0) { st2.lastWakeAt = new Date().toISOString(); st2.wolCount++; }
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sent: ok > 0, mac: route.wol.mac, broadcast: route.wol.broadcast, ports: route.wol.ports }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('waked proxy alive. GET /_wol/status\n');
  });

  if (pcfg.statusPort > 0) {
    statusServer.listen(pcfg.statusPort, pcfg.host, function () {
      log('诊断端点 http://' + pcfg.host + ':' + pcfg.statusPort + '/_wol/status');
    });
  }

  return {
    stop: function () {
      servers.forEach(function (s) { try { s.close(); } catch (e) {} });
      try { statusServer.close(); } catch (e) {}
    },
    state: state
  };
}

module.exports = { createProxy, probe, WAKE_PAGE };
