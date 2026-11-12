#!/usr/bin/env node
'use strict';
/**
 * 终端音乐播放器（零 npm 依赖）
 * 播放引擎：mpv（命名管道 JSON IPC，找不到就回退 ffplay）；元数据：ffprobe；歌词：本地 .lrc
 *
 * 用法：
 *   node player.js "<音乐目录>"
 *   node player.js "<音乐目录>" --lyrics "<歌词目录>" --lyrics "<另一个歌词目录>"
 *   node player.js "<音乐目录>" --no-recursive --volume 60
 *   node player.js "<音乐目录>" --selftest        # 非交互自检，不开 TUI
 */

const fs = require('fs');
const path = require('path');
// （无 shell 依赖，全部走 spawn / worker）

const { scan, groupByDir } = require('./lib/library');
const probe = require('./lib/probe');
const lyrics = require('./lib/lyrics');
const { FfplayBackend } = require('./lib/backend');
const { MpvBackend, findMpv } = require('./lib/backend-mpv');
const U = require('./lib/ui');
const R = require('./lib/render');
const SELFTEST = require('./lib/selftest');
const CFG = require('./lib/config');
const { pathDirs, firstFile } = require('./lib/toolsearch');
const { loadConfig, saveConfig, askForDir, playStateRecord, savePlayState, resumeTarget } = CFG;
const { displayName, songLabel, songArtist } = require('./lib/format');

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const o = {
    dir: null, lyricsDirs: [], recursive: true, volume: 80, start: 0, lyricsLines: 0,
    selftest: false, rendertest: false, playMode: null,
    volumeSet: false, startSet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lyrics' || a === '-l') {
      const v = argv[++i];
      if (v) o.lyricsDirs.push(v);          // 缺值就忽略，别把 undefined 带进 path.resolve
    }
    else if (a === '--no-recursive') o.recursive = false;
    else if (a === '--volume' || a === '-v') {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n)) { o.volume = Math.max(0, Math.min(130, n)); o.volumeSet = true; }
    }
    else if (a === '--start' || a === '-s') {
      const n = parseFloat(argv[++i]);
      if (Number.isFinite(n) && n >= 0) { o.start = n; o.startSet = true; }
    }
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--rendertest') o.rendertest = true;
    else if (a === '--lyrics-lines') o.lyricsLines = parseInt(argv[++i], 10) || 0;
    else if (a === '--backend') { const v = argv[++i]; if (v) o.backend = v; }
    else if (a === '--mpv') { const v = argv[++i]; if (v) o.mpv = v; }
    else if (a === '--mode' || a === '-m') o.playMode = String(argv[++i] || '').toLowerCase();
    else if (a === '--set-dir') { const v = argv[++i]; if (v) o.setDir = v; }
    else if (a === '--show-config') o.showConfig = true;
    else if (a === '--forget') o.forget = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else rest.push(a);
  }
  o.dir = rest[0] || null;
  return o;
}

// ---------------- 外部工具定位 ----------------
function findTool(name) {
  const dirs = ['C:\\ffmpeg\\bin', ...pathDirs()];
  const cands = [];
  for (const d of dirs) for (const e of ['.exe', '']) cands.push(path.join(d, name + e));
  return firstFile(cands) || name;   // 找不到就交给系统解析
}

// ---------------- 状态 ----------------
const state = {
  songs: [],
  view: [],
  sel: 0,
  playing: null,
  lyricsIndex: [],
  lrc: null,          // 当前歌词 {lines, meta, file, score}
  lrcIdx: -1,
  filter: '',
  dirFilter: null,    // null=全部；否则只看这个分类文件夹
  dirs: [],           // [{ name, count }]，按曲库顺序
  inputMode: false,
  viewMode: 'lyrics', // lyrics | list
  backendName: '',
  speed: 1,
  playMode: 'all',   // all 列表循环 | one 单曲循环 | shuffle 随机（旧的 "seq" 会被忽略，自动回落到 all）
  shuffleDeck: [],   // 随机模式的待播下标队列
  resume: null,      // { path, position }：启动时要接着播的位置
  message: '',
  messageAt: 0,
  scanning: false,
  dirty: true,
};

let backend = null;
let opts = null;
let lrcDirs = [];
let timer = null;
let watcher = null;
let lrcWatcher = null;
let metaQueue = [];

// 配置模块需要 state 与「当前 backend」的取值器：backend 会被整体替换（mpv 降级到 ffplay），
// 所以传的是函数而不是快照。放在这里是为了「backend 一存在就交出去」，别挪到函数定义之间。
CFG.bindRuntime(state, () => backend);

// ---------------- 工具 ----------------
function say(msg, ms = 2500) {
  state.message = msg;
  state.messageAt = Date.now() + ms;
  state.dirty = true;
}


// ---------------- 库 ----------------
function resolveLyricDirs(musicDir) {
  const out = new Set();
  // 配置里的 lyricsDirs 是用户可编辑的，非字符串（数字/null）会让 path.resolve 抛错
  for (const d of opts.lyricsDirs) { if (typeof d === 'string' && d.trim()) out.add(path.resolve(d)); }
  out.add(path.resolve(musicDir));
  const parent = path.dirname(path.resolve(musicDir));
  const cands = ['lyrics', 'Lyrics', '歌词', '歌詞', 'lrc', 'LRC'];
  for (const c of cands) {
    out.add(path.join(musicDir, c));
    out.add(path.join(parent, c));
  }
  // Windows 路径大小写不敏感，"lyrics" 与 "Lyrics" 是同一目录，必须按小写去重
  const seen = new Set();
  const uniq = [];
  for (const d of out) {
    const key = path.resolve(d).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(path.resolve(d));
  }
  return uniq.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function rescan(keepPlaying = true) {
  state.scanning = true;
  state.dirty = true;

  const list = scan(opts.dir, { recursive: opts.recursive });

  // 先看文件有没有真的变。改一个 .lrc 也会连带触发这里（歌词目录常放在曲库里面），
  // 而重建 186 个对象会丢掉已探测的元数据、重算视图、还得把光标位置找回来——全是白干。
  const prev = state.songs;
  // prev.length > 0：首扫（state.songs 还空着）必须完整走一遍，别被"没变"挡在门外
  const same = prev.length > 0 && prev.length === list.length && list.every((f, i) => {
    const p = prev[i];
    return p && p.path === f.path && p.size === f.size && Math.abs(p.mtime - f.mtime) < 1;
  });
  if (same) {
    state.scanning = false;
    return false;
  }

  // 记住选中行是哪首歌：重建视图后下标会变，靠下标会指到别的歌上
  const selBefore = state.view[state.sel] ? state.view[state.sel].path : null;

  const prevPlaying = keepPlaying ? state.playing : null;
  state.songs = list.map((f, i) => ({ ...f, id: f.path }));
  rebuildDirs();
  applyFilter();

  // 选中位置跟着「那首歌」走，而不是跟着下标走。
  // 也**不能**拉回正在播放那首——用户可能正翻到很远的地方找歌，一刷新就被拽回来。
  if (selBefore) {
    const vi = state.view.findIndex((s) => s.path === selBefore);
    if (vi >= 0) state.sel = vi;
  }

  if (prevPlaying) {
    const idx = state.songs.findIndex((s) => s.path === prevPlaying.path);
    if (idx >= 0) {
      state.playing = state.songs[idx];
    } else {
      state.playing = null;
      state.lrc = null;
      if (backend) backend.stop();
      say('当前歌曲已被移除');
    }
  }
  state.scanning = false;
  state.dirty = true;
  kickMeta();
  return true;
}

// 重新统计分类（文件夹 -> 曲目数），并把 dirFilter 收敛到仍然存在的分类
function rebuildDirs() {
  const m = groupByDir(state.songs);
  state.dirs = [...m.entries()].map(([name, count]) => ({ name: name || '(根目录)', count }));
  if (state.dirFilter && !state.dirs.some((d) => d.name === state.dirFilter)) {
    state.dirFilter = null;
  }
}

function applyFilter() {
  const f = state.filter.trim().toLowerCase();
  let base = state.songs;
  if (state.dirFilter) {
    base = base.filter((s) => ((s.relDir || '') || '(根目录)') === state.dirFilter);
  }
  state.view = f
    ? base.filter((s) => {
      const hay = [s.base, s.name, songArtist(s), (s.meta && s.meta.album) || ''].join(' ').toLowerCase();
      return hay.includes(f);
    })
    : base.slice();
  // 空视图（搜索无结果）时 length-1 = -1，会把 sel 弄成负数；两端都夹一下
  if (state.sel < 0 || state.sel >= state.view.length) state.sel = Math.max(0, state.view.length - 1);
  state.shuffleDeck = [];   // 视图变了，随机牌堆里的下标就失效了
}

// 切换分类：dirs 前面插一个"全部"
function cycleDir(step) {
  const names = [null, ...state.dirs.map((d) => d.name)];
  let i = names.indexOf(state.dirFilter);
  if (i < 0) i = 0;
  i = (i + step + names.length) % names.length;
  state.dirFilter = names[i];
  applyFilter();
  savePlayState(true);   // 强制写：savePlayState 本身有 10 秒节流，刚启动就切分类会被吞掉
  const cur = state.dirFilter || '全部';
  const n = state.view.length;
  say(`分类：${cur}（${n} 首）`, 1600);
  state.dirty = true;
}

// 背景补齐元数据（并发 3）：只探「当前播放 + 可见窗口附近」，不一次性扫全库
// 158 首的库全量探要起 158 个 ffprobe；配合磁盘缓存，第二次启动 0 次
function kickMeta() {
  const rows = (process.stdout.rows || 24);
  const from = Math.max(0, state.sel - 6);
  const to = Math.min(state.view.length, from + rows + 12);
  const want = state.view.slice(from, to);
  if (state.playing && !state.playing.meta) want.unshift(state.playing);
  let added = 0;
  for (const s of want) {
    // 探失败也算「还没到手」，可以再试一次；但别无限重试——坏文件会让 ffprobe 每 0.5 秒起一次
    if (!s.meta && !s.metaPending && (s.metaFail || 0) < 3) {
      s.metaPending = true;
      metaQueue.push(s);
      added++;
    }
  }
  if (added) pumpMeta();
  return added;
}

let metaRunning = 0;
function pumpMeta() {
  while (metaRunning < 3 && metaQueue.length) {
    const s = metaQueue.shift();
    metaRunning++;
    probe.probe(FFPROBE, s.path).then((m) => {
      // 失败不能往 song.meta 上一挂就走：kickMeta 看的是 !s.meta，
      // 挂上失败对象等于把这首歌钉死在「读取中…」，之后永不重探（旧注释说的重试根本没发生）。
      if (m && m.ok) { s.meta = m; s.metaFail = 0; }
      else { s.meta = null; s.metaFail = (s.metaFail || 0) + 1; }
      s.metaPending = false;
      metaRunning--;
      state.dirty = true;
      // 元数据到手后，如果之前没匹配到歌词，再匹配一次
      if (state.playing && state.playing.path === s.path && !state.lrc) {
        loadLyricsFor(state.playing);
      }
      pumpMeta();
    }).catch(() => {
      s.meta = null;
      s.metaFail = (s.metaFail || 0) + 1;
      s.metaPending = false;
      metaRunning--;
      pumpMeta();
    });
  }
}

// ---------------- 歌词 ----------------
function rebuildLyricsIndex() {
  state.lyricsIndex = lyrics.buildIndex(lrcDirs);
  state.dirty = true;
}

function loadLyricsFor(song) {
  const hit = lyrics.match(song, state.lyricsIndex);
  if (hit) {
    // 浅拷贝：lines 与索引缓存是同一个数组（省一次拷贝）。这里当只读用，
    // 谁要在 state.lrc.lines 上就地排序/过滤，先把数组复制一份，否则会污染缓存里所有引用它的歌。
    state.lrc = { ...hit.parsed, file: hit.file, score: hit.score };
    state.lrcIdx = -1;
  } else {
    state.lrc = null;
    state.lrcIdx = -1;
  }
  state.dirty = true;
}


// ---------------- 播放 ----------------
// loadOpts 透传给后端的 load()：{ paused: true } = 载入但不开始出声（启动时用）
async function playSong(song, startSec = 0, loadOpts = {}) {
  if (!song) return;
  // 换歌前先把上一首听到哪了落盘，这样退出/崩溃都不丢进度
  if (state.playing && state.playing.path !== song.path) savePlayState(true);
  // 上次停在半路的那首歌：第一次播它时从保存的位置接上
  if (!startSec && state.resume && state.resume.path === song.path) {
    startSec = state.resume.position || 0;
    state.resume = null;
  }
  state.playing = song;
  state.lrc = null;
  state.lrcIdx = -1;
  state.dirty = true;
  if (!song.meta) {
    // 同上：探测失败不留在 song.meta 上，否则这首歌永久停在「读取中…」、时长恒为 0
    const m = await probe.probe(FFPROBE, song.path);
    if (m && m.ok) { song.meta = m; song.metaFail = 0; }
    else { song.meta = null; song.metaFail = (song.metaFail || 0) + 1; }
    song.metaPending = false;
  }
  const dur = (song.meta && song.meta.duration) || 0;
  const vi = state.view.findIndex((s) => s.path === song.path);
  if (vi >= 0) state.sel = vi;
  loadLyricsFor(song);
  try {
    await backend.load(song.path, dur, startSec, loadOpts);
  } catch (e) {
    // mpv 起不来就自动降级到 ffplay，别让一次后端故障把整个播放器弄崩
    if (state.backendName === 'mpv' && opts.backend !== 'ffplay') {
      switchToFfplay('mpv 起不来，已切到 ffplay：' + e.message.slice(0, 70));
      try {
        await backend.load(song.path, dur, startSec, loadOpts);
      } catch (e2) {
        say('连 ffplay 也失败了：' + e2.message.slice(0, 60), 8000);
      }
    } else {
      say('播放失败：' + e.message.slice(0, 90), 8000);
    }
  }
}

function attachBackendHandlers() {
  backend.onEnded = () => {
    if (!state.view.length) { state.dirty = true; return; }
    playNext(1, true);
  };
  backend.onError = (e) => say('播放出错：' + e.message.slice(0, 80), 5000);
}

function switchToFfplay(reason) {
  try { backend.dispose(); } catch { /* 已经挂了 */ }
  backend = new FfplayBackend({ ffplay: FFPLAY, volume: opts.volume });
  state.backendName = 'ffplay';
  attachBackendHandlers();
  say(reason, 7000);
  state.dirty = true;
}

// ---------------- 播放模式 ----------------
// all 列表循环（默认，播完末首回头；范围就是当前视图＝选中的文件夹） | one 单曲循环 | shuffle 随机（洗牌不重复）
const PLAY_MODES = [
  { id: 'all', label: '循环' },
  { id: 'one', label: '单曲' },
  { id: 'shuffle', label: '随机' },
];

function playModeInfo() {
  return PLAY_MODES.find((m) => m.id === state.playMode) || PLAY_MODES[0];
}

// 纯函数：算出「当前模式按一下 m 之后是什么」，方便单测
function nextPlayModeId(id, dir = 1) {
  const i = PLAY_MODES.findIndex((m) => m.id === id);
  const j = ((i < 0 ? 0 : i) + dir + PLAY_MODES.length) % PLAY_MODES.length;
  return PLAY_MODES[j].id;
}

function cyclePlayMode(dir = 1) {
  state.playMode = nextPlayModeId(state.playMode, dir);
  state.shuffleDeck = [];   // 换模式后重新洗牌
  saveConfig({ playMode: state.playMode });
  const info = playModeInfo();
  say(`播放模式：${info.label}${info.id === 'one' ? '（播完重播这首）' : ''}`, 1600);
  state.dirty = true;
  return info;
}

// 洗一叠下标牌：当前这首压到牌堆最底，保证不会立刻重播自己
function refillShuffleDeck(cur) {
  const deck = [];
  for (let i = 0; i < state.view.length; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  if (cur >= 0) {
    const k = deck.indexOf(cur);
    if (k >= 0) { deck.splice(k, 1); deck.push(cur); }
  }
  state.shuffleDeck = deck;
  return deck;
}

// 算出下一条要播的下标；-1 只在「视图为空」时出现（已经没有「播到底就停」的模式了）
// fromEnd=true 是播完自动切，false 是手动 n/p
function nextIndex(delta, fromEnd = false) {
  const n = state.view.length;
  if (!n) return -1;
  let cur = state.view.findIndex((s) => state.playing && s.path === state.playing.path);
  if (cur < 0) cur = state.sel;
  const mode = state.playMode;

  if (mode === 'one' && fromEnd) return cur;

  if (mode === 'shuffle') {
    if (!state.shuffleDeck.length) refillShuffleDeck(cur);
    if (n === 1) return 0;
    // 往前往后都从牌堆里抽；抽到自己就再抽一张
    for (let t = 0; t < 3; t++) {
      const pick = state.shuffleDeck.pop();
      if (pick === undefined) break;
      if (pick !== cur) return pick;
    }
    return cur;
  }

  const next = cur + delta;
  // 越界就绕到另一头 —— 这就是「列表循环」，范围由 state.view 决定（＝当前分类 / 搜索结果）
  if (next < 0) return n - 1;
  if (next >= n) return 0;
  return next;
}

function playNext(delta, fromEnd = false) {
  if (!state.view.length) return;
  const i = nextIndex(delta, fromEnd);
  if (i < 0) {
    say('这个列表里已经没歌可切了', 2000);
    state.dirty = true;
    return;
  }
  if (!state.view[i]) return;
  playSong(state.view[i], 0);
}

// ---------------- 渲染（实现在 lib/render.js） ----------------
// backend 会被整体替换，每次进渲染前同步一次引用
function live() { R.setLive(state, backend, opts, playModeInfo); }
function render() { live(); R.render(); }
function renderHelp(cols) { live(); return R.renderHelp(cols); }
function helpItems() { live(); return R.helpItems(); }
function drawFrame(l) { live(); return R.drawFrame(l); }
function resetFrame() { R.resetFrame(); }
function progressBar(pos, dur, w) { return R.progressBar(pos, dur, w); }
function progressLine(cols, pos, dur) { live(); return R.progressLine(cols, pos, dur); }
function currentLrcIndex(pos) { live(); return R.currentLrcIndex(pos); }
function setFullRedraw(v) { R.setFullRedraw(v); }

// ---------------- 按键 ----------------
const KEY = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
  ctrlC: '\x03', enter: '\r', esc: '\x1b',
};

function seekBy(delta) {
  if (!backend || !backend.file) return;
  const dur = backend.duration || 0;
  const target = Math.max(0, Math.min(dur ? dur - 0.1 : 1e9, backend.position + delta));
  backend.seek(target, { commit: true });
  say(`${delta > 0 ? '快进' : '快退'} ${Math.abs(delta)}s`, 900);
}

// 倍速：只有 mpv 后端支持（ffplay 只能启动时定 -af atempo，改了要重启进程）
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function changeSpeed(dir) {
  if (!backend || typeof backend.setSpeed !== 'function') {
    say('当前后端不支持倍速（需要 mpv / mpv.net）', 2600);
    return;
  }
  const cur = backend.speed || 1;
  let i = SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.01);
  if (i < 0) i = SPEEDS.indexOf(1);
  i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
  const v = backend.setSpeed(SPEEDS[i]);
  state.speed = v;
  say(v === 1 ? '恢复正常速度' : `倍速 ${v}x`, 1200);
}

// 搜索输入模式：可打印字符进过滤条件，回车确认、Esc 取消、退格删除
function handleSearchKey(buf) {
  if (buf === KEY.enter) { state.inputMode = false; say(`过滤：${state.filter || '（无）'}`, 1200); state.dirty = true; return; }
  if (buf === KEY.esc) { state.inputMode = false; state.filter = ''; applyFilter(); state.dirty = true; return; }
  // 按码点删，不按 UTF-16 码元删：退格切掉半个 emoji 会留下孤立代理对，屏幕上是个方块
  if (buf === '\x7f' || buf === '\b') { state.filter = [...state.filter].slice(0, -1).join(''); applyFilter(); state.dirty = true; return; }
  if (buf.length === 1 && buf >= ' ') { state.filter += buf; applyFilter(); state.dirty = true; return; }
}

// 全局键：退出 / 播停 / 切视图。返回 true 表示这个键已经处理掉
function handleGlobalKey(buf) {
  switch (buf) {
    case 'q': case KEY.ctrlC: quit(); return true;
    case ' ':
      // 已经载入就切换播放/暂停；还没开始（比如刚启动）就先播选中这首
      if (backend && backend.file) backend.toggle();
      else if (state.view[state.sel]) playSong(state.view[state.sel], 0);
      state.dirty = true;
      return true;
    case KEY.esc: state.viewMode = state.viewMode === 'list' ? 'lyrics' : 'list'; state.dirty = true; return true;
    default: return false;
  }
}

// 方向键 / PgUp / PgDn / Home / End：只动选中行或播放位置
function handleNavKey(buf) {
  switch (buf) {
    case KEY.up: state.sel = Math.max(0, state.sel - 1); state.dirty = true; return true;
    case KEY.down: state.sel = Math.max(0, Math.min(state.view.length - 1, state.sel + 1)); state.dirty = true; return true;
    case KEY.right: seekBy(5); return true;
    case KEY.left: seekBy(-5); return true;
    case KEY.pgup: state.sel = Math.max(0, state.sel - 10); state.dirty = true; return true;
    case KEY.pgdn: state.sel = Math.max(0, Math.min(state.view.length - 1, state.sel + 10)); state.dirty = true; return true;
    case KEY.home: state.sel = 0; state.dirty = true; return true;
    case KEY.end: state.sel = Math.max(0, state.view.length - 1); state.dirty = true; return true;
    default: return false;
  }
}

// 其余单键动作：倍速、分类、切歌、模式、音量、重播
function handleActionKey(buf) {
  switch (buf) {
    case '<': case ',': changeSpeed(-1); savePlayState(); break;
    case '>': case '.': changeSpeed(1); savePlayState(); break;
    case '[': cycleDir(-1); break;
    case ']': cycleDir(1); break;
    case 'j': state.sel = Math.max(0, Math.min(state.view.length - 1, state.sel + 1)); state.dirty = true; break;
    case 'l': case 'L': state.viewMode = state.viewMode === 'list' ? 'lyrics' : 'list'; savePlayState(true); state.dirty = true; break;
    case 'k': state.sel = Math.max(0, state.sel - 1); state.dirty = true; break;
    case 'n': playNext(1); break;
    case 'p': playNext(-1); break;
    case 'm': cyclePlayMode(1); break;
    case 'M': cyclePlayMode(-1); break;
    case 'g': state.sel = 0; state.dirty = true; break;
    case 'G': state.sel = Math.max(0, state.view.length - 1); state.dirty = true; break;
    case '/': state.inputMode = true; state.dirty = true; break;
    // backend 为 null 只可能出现在测试/库模式里，但别让一个按键就抛异常
    case '+': case '=': if (!backend) break; backend.setVolume(backend.volume + 5); say(`音量 ${backend.volume}`, 900); savePlayState(); break;
    case '-': case '_': if (!backend) break; backend.setVolume(backend.volume - 5); say(`音量 ${backend.volume}`, 900); savePlayState(); break;
    case '\r': case '\n':
      if (state.view[state.sel]) playSong(state.view[state.sel], 0);
      break;
    default: break;
  }
}

// 按键入口：输入模式优先，然后全局键 → 导航键 → 其余动作
function handleKey(buf) {
  if (state.inputMode) return handleSearchKey(buf);
  if (handleGlobalKey(buf)) return;
  if (handleNavKey(buf)) return;
  handleActionKey(buf);
}

// 吞掉未知转义序列，避免误触
function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  const seqs = [KEY.pgup, KEY.pgdn, KEY.up, KEY.down, KEY.left, KEY.right, KEY.home, KEY.end];
  while (i < chunk.length) {
    let matched = false;
    if (chunk[i] === '\x1b') {
      for (const sq of seqs) {
        if (chunk.startsWith(sq, i)) { keys.push(sq); i += sq.length; matched = true; break; }
      }
      if (matched) continue;
      // 未知转义序列：吞到字母为止
      let j = i + 1;
      if (chunk[j] === '[') { j++; while (j < chunk.length && /[0-9;]/.test(chunk[j])) j++; }
      keys.push('\x1b');
      i = Math.min(chunk.length, j + 1);
      continue;
    }
    keys.push(chunk[i]);
    i++;
  }
  return keys;
}

// ---------------- 主循环 ----------------
let lastMetaKick = 0;
let lastIdleRender = 0;
let renderErrorLogged = false;   // 渲染异常只报一次，别把终端刷满
function tick() {
  const now = Date.now();
  // 画面只在「有变化 / 正在播放 / 消息还没过期」时重算；暂停时不再空转
  const playing = backend && backend.state === 'playing';
  const msgAlive = state.message && now < state.messageAt;
  if (state.dirty || playing || msgAlive || now - lastIdleRender > 1000) {
    if (!state.dirty && !playing && !msgAlive) lastIdleRender = now;
    try { render(); } catch (e) {
      // 渲染异常不致命，但第一次得留条线索：否则接缝出问题时只是一直不刷新，查不出来
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        console.error('渲染出错: ' + ((e && e.message) || e));
      }
    }
  }
  // 元数据每 0.5 秒补一次可见窗口（滚动后自然会把新露出的几首探掉）
  if (now - lastMetaKick > 500) { lastMetaKick = now; kickMeta(); }
  savePlayState();   // 内部 10 秒节流，退出时再强制写一次
}

function watchDirs() {
  const optsFs = { recursive: opts.recursive };
  try {
    watcher = fs.watch(opts.dir, optsFs, (evt, filename) => {
      // .lrc 交给下面的 lrcWatcher。歌词目录常常就放在曲库子目录里，不在这里滤掉的话，
      // 每存一次歌词都要重扫整个曲库。filename 各平台不保证有，没有就照常重扫（安全兜底）。
      if (filename && /\.lrc$/i.test(filename)) return;
      debounceRescan();
    });
    watcher.on('error', () => {});
  } catch {
    try { watcher = fs.watch(opts.dir, () => debounceRescan()); } catch { /* 不支持就不监视 */ }
  }
  for (const d of lrcDirs) {
    try {
      lrcWatcher = fs.watch(d, { recursive: true }, () => { debounceLrc(); });
      lrcWatcher.on('error', () => {});
      break; // 只盯第一个能盯上的目录，避免句柄过多
    } catch { /* ignore */ }
  }
}

let rescanTimer = null;
function debounceRescan() {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    const before = state.songs.length;
    rescan(true);
    const after = state.songs.length;
    if (after !== before) say(`库已更新：${before} → ${after} 首`, 2000);
  }, 400);
}

let lrcTimer = null;
function debounceLrc() {
  if (lrcTimer) clearTimeout(lrcTimer);
  lrcTimer = setTimeout(() => {
    lrcTimer = null;
    rebuildLyricsIndex();
    // 无条件重读：正在听的那首歌，改完 .lrc 保存就该立刻看到新歌词，而不是等切歌。
    // 旧逻辑只在「原本没有歌词」时才重读，改时间轴等于白改（界面一直是旧的那份）。
    if (state.playing) loadLyricsFor(state.playing);
    say(`歌词库已更新：${state.lyricsIndex.length} 个`, 1500);
  }, 400);
}

let cleaned = false;
let tuiActive = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { if (timer) clearInterval(timer); } catch {}
  try { if (watcher) watcher.close(); } catch {}
  try { if (lrcWatcher) lrcWatcher.close(); } catch {}
  try { if (backend) backend.dispose(); } catch {}
  try { probe.flushNow(); } catch { /* 缓存写不进去也不影响退出 */ }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  // 只有在 TUI 里接管过屏幕才需要还原，否则会把转义序列漏给管道输出
  if (tuiActive) {
    try { process.stdout.write(U.showCursor + U.leaveAlt); } catch {}
  }
}

function quit() {
  savePlayState(true);   // 记住听到哪、音量、倍速、当前视图
  cleanup();
  process.exit(0);
}

// ---------------- 渲染自检 / 自检（实现在 lib/selftest.js） ----------------
function selftestCtx() {
  return { state, opts, lrcDirs, backend, FFPROBE, rescan, watchDirs, cleanup, loadLyricsFor, render, setFullRedraw };
}

// ---------------- 入口 ----------------
const FFPROBE = findTool('ffprobe');
const FFPLAY = findTool('ffplay');

// ---------------- 配置（记住默认音乐目录，双击 play.cmd 就不用再输路径） ----------------
// 读写实现在 lib/config.js；这里只把 state 和「当前 backend」接给它
// （bindRuntime 在 backend 声明之后调用，见上面的变量区）

// --show-config / --set-dir / --help：一次性参数，处理完直接退出进程
function handleOneShotOptions() {
  if (opts.showConfig) {
    console.log(JSON.stringify(loadConfig(), null, 2));
    process.exit(0);
  }
  if (opts.setDir) {
    const d = path.resolve(opts.setDir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) { console.error('不是有效目录: ' + d); process.exit(1); }
    saveConfig({ musicDir: d });
    console.log('默认音乐目录已设为：' + d);
    console.log('以后直接运行 node player.js（或双击 play.cmd）就会用它。');
    process.exit(0);
  }
  if (opts.help) {
    console.log('term-player —— 终端音乐播放器（零依赖 Node，需要 PATH 里有 ffplay / ffprobe）');
    console.log('');
    console.log('用法: node player.js [音乐目录] [选项]');
    console.log('');
    console.log('  --lyrics <目录> / -l    额外的歌词目录，可以给多次');
    console.log('  --no-recursive          只扫一层，不进子文件夹');
    console.log('  --volume <0-130> / -v   音量，默认 80');
    console.log('  --start <秒> / -s       从第几秒开始');
    console.log('  --mode <all|one|shuffle> / -m   播放模式：循环 / 单曲 / 随机');
    console.log('  --backend <mpv|ffplay>  指定播放后端');
    console.log('  --mpv <路径>            指定 mpv / mpv.net 可执行文件');
    console.log('  --lyrics-lines <行数>   固定歌词区高度');
    console.log('  --set-dir <目录>        记住默认音乐目录，以后直接 node player.js');
    console.log('  --show-config           打印当前配置');
    console.log('  --forget                忘掉上次播放进度（其它配置不变）');
    console.log('  --selftest              非交互自检：扫描 / 元数据 / 后端');
    console.log('  --rendertest            渲染一帧并检查有没有超宽行');
    console.log('');
    console.log('运行中按键:');
    console.log('  空格 播/停   ↑↓ kj 选曲   Enter 播放   ←→ 快退/快进 5s   <> 倍速');
    console.log('  n/p 切歌   m/M 播放模式   [ ] 分类   +/- 音量   / 搜索   l 列表   q 退出');
    process.exit(0);
  }
}

// 配置里的值填进 opts / state：命令行永远优先于配置
function mergeConfigIntoOpts(cfg) {
  if (!opts.dir && typeof cfg.musicDir === 'string' && cfg.musicDir) opts.dir = cfg.musicDir;
  if (!opts.lyricsDirs.length && Array.isArray(cfg.lyricsDirs) && cfg.lyricsDirs.length) {
    opts.lyricsDirs = cfg.lyricsDirs.slice();
  }
  // 播放模式：命令行 > 配置 > 默认顺序
  const modeFrom = opts.playMode || cfg.playMode;
  if (PLAY_MODES.some((m) => m.id === modeFrom)) state.playMode = modeFrom;
  // 音量 / 倍速 / 视图：命令行没给就用上次记住的
  if (!opts.volumeSet && Number.isFinite(cfg.volume)) opts.volume = cfg.volume;
  if (Number.isFinite(cfg.speed) && cfg.speed >= 0.25 && cfg.speed <= 4) state.speed = cfg.speed;
  if (cfg.viewMode === 'list' || cfg.viewMode === 'lyrics') state.viewMode = cfg.viewMode;
  // 上次停在哪个分类就还回哪个（非字符串一律忽略，防止配置被手工改坏）
  if (typeof cfg.dirFilter === 'string' && cfg.dirFilter) state.dirFilter = cfg.dirFilter;
}

// 目录：命令行 > 配置 > 在终端里问一句；问出来的存进配置
async function ensureMusicDir() {
  if (!opts.dir) {
    if (!process.stdin.isTTY) {
      console.log('用法: node player.js <音乐目录> [--lyrics <歌词目录>]... [--no-recursive] [--volume 80] [--start 秒]');
      console.log('第一次用：把路径换成你的音乐文件夹，执行下面这一行（只需一次，之后直接 node player.js）');
      console.log('  node player.js "<你的音乐目录>" --set-dir "<你的音乐目录>"');
      process.exit(1);
    }
    opts.dir = await askForDir();
    if (!opts.dir) { console.error('没有指定目录'); process.exit(1); }
    // 这次是问出来的，就记成默认目录，下次直接启动
    if (saveConfig({ musicDir: opts.dir })) {
      console.log(`已记住默认目录：${opts.dir}（下次直接运行即可，改的话用 --set-dir）`);
    }
  }
  let st;
  try { st = fs.statSync(opts.dir); } catch {
    console.error('目录不存在: ' + opts.dir);
    process.exit(1);
  }
  if (!st.isDirectory()) { console.error('不是目录: ' + opts.dir); process.exit(1); }
}

// 选后端：显式 --backend，否则有 mpv/mpv.net 就用它（能实时暂停/seek/倍速/音量）
function createBackend() {
  const mpvExe = opts.backend === 'ffplay' ? null : findMpv(opts.mpv);
  if (mpvExe) {
    backend = new MpvBackend({ exe: mpvExe, volume: opts.volume });
    state.backendName = 'mpv';
  } else {
    if (opts.backend === 'mpv') {
      console.error('没找到 mpv/mpv.net；可用 --mpv <路径> 指定，或去掉 --backend mpv 用 ffplay');
      process.exit(1);
    }
    backend = new FfplayBackend({ ffplay: FFPLAY, volume: opts.volume });
    state.backendName = 'ffplay';
  }
  attachBackendHandlers();
  // 上次记住的倍速直接应用（mpv 支持运行时变速；ffplay 会自己忽略）
  if (state.speed && state.speed !== 1 && typeof backend.setSpeed === 'function') {
    try { backend.setSpeed(state.speed); } catch { /* 不支持就算了 */ }
  }
}

// 进 TUI：接管终端、接键盘、启动主循环
function startTui(rt) {
  tuiActive = true;
  process.stdout.write(U.enterAlt + U.hideCursor + U.clear);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const k of splitKeys(chunk)) handleKey(k);
  });
  process.stdout.on('resize', () => { resetFrame(); state.dirty = true; });

  // 启动就载入，但**先不播**：停在上次那个位置（或 0）的暂停状态，
  // 按空格才开始出声 —— 免得一开窗口就突然放歌。
  if (state.view.length) playSong(state.view[rt.index] || state.view[0], opts.start || 0, { paused: true });

  watchDirs();
  state.dirty = true;
  timer = setInterval(tick, 50);   // 20fps，配合差分重绘，歌词逐字高亮才跟得上
  tick();
}

async function main() {
  opts = parseArgs(process.argv.slice(2));
  handleOneShotOptions();          // --show-config / --set-dir / --help 在这里处理完就退出

  const cfg = loadConfig();
  mergeConfigIntoOpts(cfg);

  if (opts.forget) {
    saveConfig({ last: null });
    console.log('已忘掉上次播放进度（其它配置不变）');
    process.exit(0);
  }

  await ensureMusicDir();

  lrcDirs = resolveLyricDirs(opts.dir);
  // 元数据磁盘缓存：放在 config.json 旁边，删掉也不影响功能（只是下次要重探）
  try { probe.openDisk(path.join(__dirname, 'meta-cache.json')); } catch { /* 没有也能跑 */ }

  createBackend();
  rebuildLyricsIndex();

  // 自检/排版测试是工具，不是用户在用：别把伪造的播放进度写进用户的 config.json
  if (opts.rendertest || opts.selftest) CFG.setPersist(false);

  if (opts.rendertest) { SELFTEST.rendertest(selftestCtx()); return; }
  if (opts.selftest) { SELFTEST.selftest(selftestCtx()); return; }

  if (!process.stdin.isTTY) {
    console.error('需要在交互式终端里运行（或用 --selftest 做非交互自检）');
    console.error('双击 play.cmd，或在 Windows Terminal / PowerShell 窗口里跑 node player.js');
    process.exit(1);
  }

  rescan(false);
  state.sel = 0;
  // 恢复上次：回到那首歌、那个位置（--start 优先）
  const rt = resumeTarget(state.view, cfg.last, opts.startSet ? opts.start : 0);
  state.sel = rt.index;
  if (rt.found && rt.pos > 0) {
    state.resume = { path: state.view[rt.index].path, position: rt.pos };
    say(`上次停在 ${U.fmtTime(rt.pos)}，从这里接着放`, 5000);
  }
  startTui(rt);
}

// 作为库被 require 时导出内部件，供零依赖单元测试用；直接运行才启动 TUI
if (require.main === module) {
  process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
  process.on('SIGINT', () => quit());
  process.on('SIGTERM', () => quit());
  process.on('exit', () => { try { cleanup(); } catch {} });
  main().catch((e) => { cleanup(); console.error(e); process.exit(1); });
} else {
  module.exports = {
    parseArgs,
    state,
    KEY,
    splitKeys,
    handleKey,
    render,
    renderHelp,
    resetFrame,
    setFullRedraw,
    drawFrame,
    selftestCtx,   // 供单测断言字段完整性（少一个只会让 --selftest 崩，很难发现）
    progressBar,
    cycleDir,
    rebuildDirs,
    rescan,
    songLabel,
    displayName,
    applyFilter,
    loadLyricsFor,
    currentLrcIndex,
    rebuildLyricsIndex,
    playSong,
    playNext,
    seekBy,
    nextIndex,
    nextPlayModeId,
    cyclePlayMode,
    refillShuffleDeck,
    helpItems,
    PLAY_MODES,
    playStateRecord,
    savePlayState,
    resumeTarget,
    progressLine,
    tick,
    kickMeta,
    setPersist: CFG.setPersist,
    resolveLyricDirs,
    say,
    setOpts: (o) => { opts = o; },
    getOpts: () => opts,
    setLyricDirs: (d) => { lrcDirs = d; },
    setBackend: (b) => { backend = b; },
    getBackend: () => backend,
  };
}
