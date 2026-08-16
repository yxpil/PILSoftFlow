'use strict';
// MAC -> IP 解析(通过系统 ARP 表)
//
// 后端机器 IP 可能是 DHCP 动态分配的,配置里只写 MAC,
// 运行时从 ARP 表反查当前 IP:
//   Linux   : 读 /proc/net/arp(无需额外权限,内核维护)
//   Windows : 执行 arp -a 解析输出(开发/测试用)
//
// 可注入 readFile/exec 以便测试;返回 (mac) => ip|null

function normalizeMac(mac) {
  return String(mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function normalizeMacHex(hex) {
  // 'aabbccddeeff' -> 6 组小写十六进制,与 normalizeMac 输出可比
  return String(hex || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

// /proc/net/arp 格式:
//   IP address       HW type     Flags       HW address            Mask     Device
//   192.168.1.100    0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0
// Flags 含 0x2 = ARP 条目 complete(有效)
function parseLinuxArp(text, wantMac) {
  const lines = String(text).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 6) continue;
    const flags = parseInt(parts[2], 16);
    if (isNaN(flags) || (flags & 0x2) === 0) continue; // 跳过 incomplete/失败条目
    if (parts[0] === '0.0.0.0') continue;
    const hw = normalizeMac(parts[3]);
    if (!hw || hw === '000000000000') continue;
    if (hw === wantMac) return parts[0];
  }
  return null;
}

// Windows arp -a 输出:
//   Interface: 192.168.1.50 --- 0x5
//     Internet Address      Physical Address      Type
//     192.168.1.100         aa-bb-cc-dd-ee-ff     dynamic
function parseWindowsArp(text, wantMac) {
  const lines = String(text).split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) continue; // 首列必须是 IPv4
    if (parts[0] === '0.0.0.0') continue;
    const hw = normalizeMac(parts[1]);
    if (!hw || hw === '000000000000') continue;
    if (hw === wantMac) return parts[0];
  }
  return null;
}

// 创建解析器:返回 (mac) => ip|null(全同步,可注入依赖以便测试)
function createResolver(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const readFileSync = opts.readFileSync || require('fs').readFileSync;
  const execSync = opts.execSync || function (cmd) {
    return require('child_process').execSync(cmd, { encoding: 'utf8' });
  };

  return function resolveMacToIp(mac) {
    const want = normalizeMac(mac);
    if (!want) return null;

    if (platform === 'win32') {
      let out = '';
      try { out = execSync('arp -a'); } catch (e) { return null; }
      return parseWindowsArp(out, want);
    }
    // Linux / 其他:尝试 /proc/net/arp
    let text = '';
    try {
      text = readFileSync('/proc/net/arp', 'utf8');
    } catch (e) {
      return null;
    }
    return parseLinuxArp(text, want);
  };
}

module.exports = { createResolver, parseLinuxArp, parseWindowsArp, normalizeMac };
