'use strict';
// WOL 魔法包生成与发送(UDP 端口 7 和 9)

const dgram = require('dgram');

// 生成魔法包:6 字节 FF + 目标 MAC 重复 16 次,共 102 字节
function magicPacket(mac) {
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error('MAC 格式错误: ' + mac);
  const macBuf = Buffer.from(hex, 'hex');
  const pkt = Buffer.alloc(6 + 16 * 6);
  pkt.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBuf.copy(pkt, 6 + i * 6);
  }
  return pkt;
}

// 向 broadcast:ports 各发一轮魔法包,返回成功发送数
function sendWol(opts, log) {
  const { mac, broadcast, ports } = opts;
  const pkt = magicPacket(mac);
  const sends = [];
  for (const port of ports) {
    sends.push(new Promise(function (resolve) {
      const sock = dgram.createSocket('udp4');
      sock.on('error', function (e) {
        log('WOL 发送失败 ' + broadcast + ':' + port + ' (' + e.code + ')');
        try { sock.close(); } catch (x) { /* ignore */ }
        resolve(false);
      });
      sock.send(pkt, 0, pkt.length, port, broadcast, function (err) {
        sock.close();
        resolve(!err);
      });
    }));
  }
  return Promise.all(sends).then(function (results) {
    const ok = results.filter(Boolean).length;
    if (ok > 0) log('WOL 已发送 ' + ok + '/' + ports.length + ' 端口 -> ' + mac + ' @ ' + broadcast + ':' + ports.join(','));
    return ok;
  });
}

module.exports = { magicPacket, sendWol };
