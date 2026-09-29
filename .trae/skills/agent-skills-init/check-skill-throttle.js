#!/usr/bin/env node
/**
 * 技能检查节流脚本（跨平台：Windows / macOS / Linux）
 * 用法：node check-skill-throttle.js <分身标识> [节流小时数，默认48]
 * 输出：FRESH   → 节流期内，静默跳过技能检查
 *       EXPIRED → 已过期（同时已刷新时间戳），需弹出"是否检查更新"询问框
 * 时间戳文件：~/.skillshub/last-skill-check.json（所有项目共享，按分身名区分）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const agent = process.argv[2];
const hours = Number(process.argv[3]) || 48;
if (!agent) {
  console.error('用法: node check-skill-throttle.js <分身标识> [小时数]');
  process.exit(1);
}

const file = path.join(os.homedir(), '.skillshub', 'last-skill-check.json');

let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (_) { /* 文件不存在或损坏，视为首次 */ }

const last = Date.parse(data[agent]);
if (!isNaN(last) && Date.now() - last < hours * 3600 * 1000) {
  console.log('FRESH');
} else {
  data[agent] = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (_) { /* 写入失败不阻断 */ }
  console.log('EXPIRED');
}
