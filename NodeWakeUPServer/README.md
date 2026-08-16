# NodeWakeUPServer — 分代理服务器端(WOL 唤醒代理)

纯 Node.js 零依赖。部署在分代理机器(常开机、负责唤醒重型机的那台)。

## 职责

收到访问请求时:

- **后端在线** → 直接双向透传流量
- **后端离线** → 发 WOL 魔法包(UDP 7 + 9 双端口)唤醒重型服务器:
  - HTTP 请求 → 返回"正在唤醒"页(自动刷新,后端就绪后页面自动变成真实服务)
  - SSH/数据库等协议 → 保持连接,周期探测,后端就绪后自动透传
- **MAC 绑定动态 IP** → 配置只填 MAC(用户填写),每次探测前经 ARP 表反查当前 IP,DHCP 换 IP 自动跟随

## 运行

```bash
node server.js start --config config.json          # 启动唤醒代理
node server.js wake --mac AA:BB:CC:DD:EE:FF        # 手动发送 WOL
node test/e2e.js                                   # 测试(33 项)
```

## 管理面板

`http://<代理机>:9090/` 简约黑白面板,实时显示:

- **分代理服务器**:各路由(监听端口 → 后端)、在线/离线/**正在唤醒** 状态、当前解析 IP、WOL 次数,手动唤醒按钮
- **重型服务器端**:通过路由 `heavyStatusUrl` 轮询 NodeSleepServer 状态端点,显示监视端口/空闲阈值/关机倒计时,手动关机按钮

## 配置(config.example.json)

```jsonc
{
  "proxy": {
    "statusPort": 9090,          // 管理面板端口
    "routes": [{
      "listenPort": 80,          // 代理公开端口(自定义路由)
      "backendMac": "AA:BB:CC:DD:EE:FF",  // 方式A:MAC 绑定动态 IP(经 ARP 反查)
      "backendPort": 8080,
      // "backend": "192.168.1.100:8080", // 方式B:静态 IP
      "heavyStatusUrl": "http://192.168.1.100:19100/", // 重型机状态端点(面板用)
      "wol": { "mac": "AA:BB:CC:DD:EE:FF", "broadcast": "192.168.1.255", "ports": [7, 9] }
    }]
  }
}
```

## 部署(Linux + systemd)

```bash
sudo cp -r . /opt/wakeup-server/
sudo cp config.example.json /etc/wakeup-server/config.json   # 修改 MAC/路由
sudo cp deploy/wakeup-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wakeup-server
```

## 配套

重型服务器端见 **NodeSleepServer**(空闲自动关机守护)。两者通过 `heavyStatusUrl` 联动。
