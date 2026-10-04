# PILSoftFlow

自动关机 + WOL 唤醒一体服务。纯 Node.js 零依赖(仅内置模块),适配 Linux。

## 组成

| 目录 | 角色 | 职责 |
|---|---|---|
| [NodeWakeUPServer](NodeWakeUPServer/) | 分代理服务器端 | 访问入口:后端在线透传;离线发 WOL(UDP 7/9)唤醒,显示"正在唤醒";MAC 绑定动态 IP(ARP 反查);管理面板 |
| [NodeSleepServer](NodeSleepServer/) | 重型服务器端 | 空闲自动关机:监视业务端口(/proc/net/tcp),N 分钟无连接自动关机;状态/控制端点 |

## 工作闭环

```
客户端 -> 代理机:20726 -> 后端在线? -> 透传
                         └─ 离线 -> WOL 唤醒(UDP 7/9) + "正在唤醒"页 -> 开机 -> 透传
重型机: 5 分钟无访问 -> systemctl poweroff
```

## 快速开始

```bash
# 分代理机器(NodeWakeUPServer)
cd NodeWakeUPServer
cp config.example.json config.json   # 填 MAC/路由
npm start

# 重型服务器(NodeSleepServer)
cd NodeSleepServer
cp config.example.json config.json
npm start -- --dry-run   # 先试跑
```

各项目 README 内含完整配置、部署(systemd)、测试说明。

## 测试

```bash
cd NodeWakeUPServer && npm test   # 33 项
cd NodeSleepServer && npm test    # 14 项
```

---

<div align="center">

<a href="https://github.com/yxpil/PILSoftFlow">
  <img width="100%" src="https://alittlecatgirlpanel.yxp.hk/card?repo=yxpil/PILSoftFlow" alt="gh-card · yxpil/PILSoftFlow" />
</a>

<sub>Powered by <a href="https://alittlecatgirlpanel.yxp.hk"><b>gh-card</b></a> · 粉色手写体 README 仓库名片</sub>

</div>
