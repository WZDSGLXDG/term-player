'use strict';
// 配置读写 + "记住听到哪"：只碰 config.json，不碰界面
const fs = require('fs');
const path = require('path');

// player.js 注入的运行时引用：state 对象 + 当前 backend 的取值器
// （backend 会被整体替换——mpv 降级到 ffplay——所以必须用函数取，不能用快照）
let state = null;
let getBackend = () => null;
function bindRuntime(s, gb) { state = s; getBackend = gb; }

// ---------------- 配置（记住默认音乐目录，双击 play.cmd 就不用再输路径） ----------------
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // 只认普通对象：数组/字符串/数字/null 一律当空配置，
    // 否则 saveConfig 里 {...cur} 会把索引键/字符键写进配置，永久损坏用户设置
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { return {}; }
}

// 记住播放进度与设置：只写 config.json，测试里可以用 setPersist(false) 关掉
let persist = true;
// 从"现在"开始算：启动瞬间 backend 还没 load 完，position 是 0，
// 那时写盘会把上次的进度抹成 0。推迟 10 秒写，届时位置已经就绪。
let lastStateSave = Date.now();

// 纯函数：这次该往配置里写什么（方便单测，不碰磁盘）
function playStateRecord() {
  // bindRuntime 还没接上（或接错了）时宁可不写盘，也别让 tick 的定时写盘变成 TypeError
  if (!state) return {};
  const backend = getBackend();   // backend 会被整体替换，不能用快照
  const patch = {};
  if (backend) {
    patch.volume = backend.volume;
    patch.speed = backend.speed || 1;
  }
  patch.viewMode = state.viewMode;
  // 记住当前分类：退出时停在某个分类，下次进来还是那个。
  // 文件夹被删了不要紧，rebuildDirs() 会把它收敛回 null（全部）。
  patch.dirFilter = state.dirFilter || null;
  const s = state.playing;
  if (s && s.path) {
    const loaded = backend && backend.file === s.path;
    // 后端还没载入这首（启动瞬间就按 q 退出、或 load 失败）时**不要碰 last**：
    // 原来这时算出 position=0 写回去，会把上次听到哪永久抹成 0。
    if (loaded) {
      const dur = backend.duration || (s.meta && s.meta.duration) || 0;
      let pos = backend.position || 0;
      // 开头 3 秒内、结尾 5 秒内都不值得续播，当作从头开始
      if (pos <= 3 || (dur > 0 && pos >= dur - 5)) pos = 0;
      patch.last = { path: s.path, position: Math.round(pos), at: Date.now() };
    }
  }
  return patch;
}

function savePlayState(force = false) {
  const now = Date.now();
  if (!force && now - lastStateSave < 10000) return false;   // 10 秒最多写一次盘
  lastStateSave = now;
  return saveConfig(playStateRecord());
}

// 纯函数：启动时该从第几首、哪个位置开始（命令行 --start 优先，其次上次进度）
function resumeTarget(view, last, cliStart) {
  const fallback = { index: 0, pos: cliStart || 0, found: false };
  if (!last || !last.path || !Array.isArray(view)) return fallback;
  const i = view.findIndex((s) => s.path === last.path);
  if (i < 0) return fallback;                       // 歌被删了 / 不在当前视图
  const pos = cliStart || (Number(last.position) > 3 ? Number(last.position) : 0);
  return { index: i, pos, found: true };
}

function saveConfig(patch) {
  if (!persist) return false;   // 单元测试里关掉，避免动用户的 config.json
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  const tmp = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);   // 原子替换：写到一半崩溃不会留下半个配置
    return true;
  } catch (e) {
    console.error('写配置失败: ' + e.message);
    try { fs.unlinkSync(tmp); } catch { /* 已经不存在就算了 */ }
    return false;
  }
}

// 没给目录时在终端里问一句（支持把文件夹拖进窗口）
function askForDir() {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('请输入音乐文件夹路径（可把文件夹拖进来，直接回车用当前目录）: ', (ans) => {
      rl.close();
      let p = String(ans || '').trim().replace(/^["']|["']$/g, '');
      if (!p) p = process.cwd();
      resolve(p);
    });
  });
}

function setPersist(v) { persist = !!v; }

module.exports = {
  CONFIG_PATH, bindRuntime, setPersist,
  loadConfig, saveConfig, askForDir,
  playStateRecord, savePlayState, resumeTarget,
};
