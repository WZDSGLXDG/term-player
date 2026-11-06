'use strict';
// 验证：mpv.net 的窗口被隐藏后，切歌会不会重新冒出来
// 运行：node test/window-test.js
const path = require('path');
const { execFileSync } = require('child_process');
const { MpvBackend, findMpv } = require('../lib/backend-mpv');

const SCRIPT = path.join(__dirname, '..', 'lib', 'hide-window.ps1');
// 用哪个库：命令行参数 > TP_MUSIC；都没有就跳过——这个脚本只验证「mpv.net 的窗口被藏住」，
// 原来写死的是作者本机的两首歌，别人机器上跑不了。
const DIR = process.argv[2] || process.env.TP_MUSIC || '';
const SONGS = DIR ? require('../lib/library').scan(DIR, { recursive: true }).slice(0, 2).map((s) => s.path) : [];
if (SONGS.length < 2) {
  console.log('用法: node test/window-test.js <音乐目录>    （需要至少 2 首可播文件；也可设 TP_MUSIC）');
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function windowState(pid) {
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, String(pid),
    ], { encoding: 'utf8', timeout: 12000 }).trim();
  } catch (e) {
    return 'err: ' + e.message;
  }
}

(async () => {
  const exe = findMpv();
  if (!exe) { console.log('没找到 mpv/mpv.net'); process.exit(1); }
  console.log('mpv =', exe);

  const b = new MpvBackend({ exe, volume: 5 });
  await b.load(SONGS[0], 232, 10);
  await sleep(2500);
  console.log('第 1 首后 窗口状态:', windowState(b._child.pid), '| 位置', b.position.toFixed(2));

  await b.load(SONGS[1], 250, 5);
  await sleep(2500);
  console.log('切到第 2 首后 窗口状态:', windowState(b._child.pid), '| 位置', b.position.toFixed(2));

  await sleep(1500);
  console.log('再等 1.5s   窗口状态:', windowState(b._child.pid), '| 位置', b.position.toFixed(2));

  b.dispose();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
