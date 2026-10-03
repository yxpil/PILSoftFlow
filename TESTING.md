# PILSoftFlow 测试说明

本仓库包含两个独立的零依赖 Node.js 子项目，各自有独立的 `package.json` 与 `tests/`。测试基于 Node.js 内置运行器 `node --test`，无需安装任何依赖。

## 运行方式

```bash
# 重型服务器端：空闲自动关机
cd NodeSleepServer && npm test

# 分代理服务器端：WOL 唤醒代理
cd NodeWakeUPServer && npm test
```

> 备注：各子项目原有的 `test/e2e.js` 是手工 e2e 脚手架，已保留为 `npm run test:e2e`。

## 测了什么

### NodeSleepServer（9 个用例）
- `tests/unit/config.test.js` —— 配置加载与校验：默认值合并、缺端口报错、`idleMinutes`/`checkIntervalSec` 边界、`watchPorts` 非数组收敛。
- `tests/unit/scan.test.js` —— `scanEstablishedPorts` 解析 `/proc/net/tcp`：只收集 ESTABLISHED(st=01)、十六进制端口转十进制、文件不可读安全跳过、tcp+tcp6 合并。
- `tests/integration/server.test.js` —— dryRun 模式真实起服务：状态端点返回 JSON、`POST /_heavy/shutdown` 在 dryRun 下标记 fired 但不真关机。

### NodeWakeUPServer（13 个用例）
- `tests/unit/wol.test.js` —— `magicPacket` 结构（102 字节、6×0xFF、MAC×16）、分隔符归一、非法 MAC 抛错。
- `tests/unit/config.test.js` —— `splitHostPort`（IPv4/IPv6/无端口）、路由校验（listenPort 范围、backend/backendMac 二选一、MAC 格式）。
- `tests/unit/arp.test.js` —— Linux/Windows ARP 表解析：complete 条目命中、incomplete/0.0.0.0/全零 MAC 跳过。
- `tests/integration/proxy.test.js` —— 真实 TCP 回路：在线后端双向透传、`/_wol/status` 诊断端点、未知 route 返回 404。

### 注入 / 安全测试
- **MAC 注入**：非 hex、空、长度错误的 MAC 在 `magicPacket` / 配置校验阶段直接抛错，不静默构造错误魔法包。
- **脏路由配置**：`backend` 缺省/格式错、`listenPort` 越界（0 / 70000）、`wol.mac=<script>` 均在加载期被拒绝。
- **ARP 表不可信输入**：畸形行、非 IPv4 行、incomplete 条目、全零 MAC 一律跳过，不返回伪造 IP。
- **诊断端点**：`/_wol/wake?route=99999` 未知路由返回 404 而非崩溃。

> 本仓库为后端守护/代理，无浏览器前端交互，故不涉及 jsdom 钩子测试。

## 预期结果

```
NodeSleepServer:  # tests 9   # pass 9   # fail 0
NodeWakeUPServer: # tests 13  # pass 13  # fail 0
```

合计 22 个用例全部通过（单测 20 + 集成 2）。
