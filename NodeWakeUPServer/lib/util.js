'use strict';
// 轻量日志:带时间戳与模块标签,无 emoji

function ts() {
  return new Date().toISOString();
}

function log(tag, msg) {
  console.log('[' + ts() + '] [' + tag + '] ' + msg);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

module.exports = { log, sleep, ts };
