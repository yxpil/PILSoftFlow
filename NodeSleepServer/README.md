# NodeSleepServer — 重型服务器端(空闲自动关机守护)

纯 Node.js 零依赖。部署在重型服务器(随业务服务共存,负责空闲自动关机)。

## 职责

- **监视业务端口**:周期扫描 `/proc/net/tcp`(+tcp6),若任一 `watchPorts` 存在 ESTABLISHED 连接即视为活跃(不占用业务端口,与真实服务共存)
- **空闲自动关机**:超过 `idleMinutes` 分钟无任何访问 → 执行 `shutdownCmd`(默认 `systemctl poweroff`)
- **状态/控制端点**(可选):供 NodeWakeUPServer 管理面板查询倒计时、手动触发关机

## 运行

```bash
node server.js start --config config.json            # 启动守护(需 root)
node server.js start --config config.json --dry-run  # 试跑:只打日志不真关机
node test/e2e.js                                     # 测试(14 项)
```

## 配置(config.example.json)

```jsonc
{
  "heavy": {
    "watchPorts": [8080, 8081],       // 监视的业务端口(/proc/net/tcp 模式)
    "idleMinutes": 5,                 // 空闲 N 分钟无访问 -> 关机
    "checkIntervalSec": 30,           // 扫描周期
    "shutdownCmd": "systemctl poweroff",  // 关机命令
    "statusPort": 19100               // 状态/控制端点(0=关闭)
  }
}
```

## 状态/控制端点

```bash
curl http://<重型机>:19100/                  # 状态 JSON(倒计时/监视端口/触发状态)
curl -X POST http://<重型机>:19100/_heavy/shutdown   # 手动触发关机
```

## 部署(Linux + systemd)

```bash
sudo cp -r . /opt/sleep-server/
sudo cp config.example.json /etc/sleep-server/config.json
sudo cp deploy/sleep-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sleep-server
# 上线前先试跑:
node /opt/sleep-server/server.js start --config /etc/sleep-server/config.json --dry-run
```

## 前提

- 需 root 权限(读 /proc/net/tcp + 执行关机命令)
- 适配 DHCP 动态 IP:关机由本机执行,与 IP 无关;唤醒方(NodeWakeUPServer)通过 MAC+ARP 反查当前 IP

## 配套

唤醒代理见 **NodeWakeUPServer**(WOL 唤醒代理)。工作闭环:无人访问 → 本机自动关机 → 有人访问 → WakeUPServer 发 WOL → 本机开机 → 代理透传流量 → 计时重置。
