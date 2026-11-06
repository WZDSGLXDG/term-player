'use strict';
// 终端渲染：一帧的构造、差分重绘、进度条、歌词区、列表区。
// 只读 state / backend / opts（由 player.js 的 setLive 同步），不改它们。
const path = require('path');
const U = require('./ui');
const { songLabel, songArtist, fmtInfo } = require('./format');

// backend 会被整体替换（mpv 降级到 ffplay），所以每次进渲染前重新同步引用
let state = null;
let backend = null;
let opts = null;
// helpItems 要显示当前播放模式；player.js 在 setLive 时把它传进来
let playModeInfo = () => ({ id: 'all', label: '循环' });
function setLive(s, b, o, pm) { state = s; backend = b; opts = o; if (pm) playModeInfo = pm; }

function currentLrcIndex(pos) {
  const L = state.lrc && state.lrc.lines;
  if (!L || !L.length) return -1;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---------------- 渲染 ----------------
// 进度条：实心块 + 脉动播放头，比细线显眼
function progressBar(pos, dur, w) {
  const C = U.C;
  const ratio = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
  const width = Math.max(10, w);
  const filled = Math.round(ratio * width);
  const pulse = ['█', '▓', '▒'][Math.floor(Date.now() / 350) % 3];
  let s = '';
  if (filled > 0) {
    s += C.fg(44) + '█'.repeat(Math.max(0, filled - 1));
    s += C.bold + C.fg(51) + (dur > 0 ? pulse : '█') + C.reset;
    if (filled < width) s += C.fg(236) + '─'.repeat(width - filled) + C.reset;
  } else {
    // 0% 时播放头占用 1 列，剩余必须减 1，否则整条会宽一格
    s += C.fg(52) + (dur > 0 ? pulse : '▏') + C.reset;
    s += C.fg(236) + '─'.repeat(Math.max(0, width - 1)) + C.reset;
  }
  return s;
}

// 分类导航条：全部 · 流行 96 · 摇滚 58 …，当前分类反显
function renderDirBar(cols) {
  const C = U.C;
  const items = [{ name: null, count: state.songs.length }].concat(state.dirs);
  let line = ' ';
  let used = 1;
  const sepPlain = '  ·  ';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = it.name === null ? `全部 ${it.count}` : `${it.name} ${it.count}`;
    const plain = ` ${label} `;
    const need = U.width(plain) + (i > 0 ? U.width(sepPlain) : 0);
    if (used + need > cols - 2 && i > 0) {
      line += C.fg(238) + ' …' + C.reset;
      break;
    }
    if (i > 0) { line += C.fg(238) + sepPlain + C.reset; used += U.width(sepPlain); }
    const active = state.dirFilter === it.name;
    line += active
      ? C.bg(24) + C.bold + C.fg(195) + plain + C.reset
      : C.fg(245) + plain + C.reset;
    used += U.width(plain);
  }
  return line;
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const out = [];
  const C = U.C;

  const s = state.playing;
  const pos = backend ? backend.position : 0;
  const dur = (s && s.meta && s.meta.duration) || (backend && backend.duration) || 0;

  // 第 1 行：曲库概况 + 临时消息
  const libLine = `${state.songs.length} 首` + (state.filter ? ` · 搜索 "${state.filter}"` : '');
  const msg = state.message && Date.now() < state.messageAt ? state.message : '';
  out.push(
    C.fg(240) + U.padEnd(` ♪ ${path.basename(path.resolve(opts.dir))}  ${libLine}` + (state.scanning ? ' 扫描中…' : ''),
      Math.max(10, cols - U.width(msg) - 2)) + C.reset +
    (msg ? C.fg(214) + msg + C.reset : '') + ' '
  );

  // 第 2 行：分类导航（用 [ ] 切换）
  out.push(renderDirBar(cols));

  if (state.viewMode === 'list') {
    renderList(out, cols, rows);
  } else {
    renderNowPlaying(out, cols, rows, s, pos, dur);
  }

  // 底部按键提示（贴底，按键名高亮）
  out.push(renderHelp(cols));

  while (out.length < rows) out.push('');
  drawFrame(out.slice(0, rows));
  // 搜索时把**硬件光标**放到输入框里（用户能看见自己在哪打字），退出时马上藏回去
  if (state.inputMode && helpCursorCol > 0) {
    process.stdout.write(`\x1b[${rows};${helpCursorCol}H` + U.showCursor);
    cursorShown = true;
  } else if (cursorShown) {
    process.stdout.write(U.hideCursor);
    cursorShown = false;
  }
  state.dirty = false;
}

// 按键提示：整行深灰底做成状态条，按键名亮青加粗、说明浅灰
// 顺序＝截断优先级：窄屏放不下时先丢掉后面几项，所以常用键放前面
// m 那一项的说明就是**当前播放模式**，顺手当状态显示
function helpItems() {
  return [
    ['空格', '播/停'], ['m', playModeInfo().label], ['↑↓', '选曲'], ['np', '切歌'],
    ['<>', '倍速'], ['←→', '5s'],
    ['q', '退出'], ['l', '列表'], ['[]', '分类'], ['+-', '音量'], ['/', '搜索'],
  ];
}
let helpCursorCol = 0;   // 搜索输入时光标应该在的列（0 = 不在输入模式）
let cursorShown = false;  // 硬件光标当前是否显示
function renderHelp(cols) {
  const C = U.C;
  const limit = Math.max(1, cols - 1);   // 留 1 列：贴底行写满整行在部分终端会触发换行滚动
  if (state.inputMode) {
    // 输入框：固定宽度（最多 30 列），右边留白——框窄一点，「框里就是输入区」才一眼看得出来
    const head = ' 搜索 ';
    const cnt = state.filter ? `  ${state.view.length} 首` : '';
    let tail = '  Enter 确认 · Esc 取消';
    let boxW = limit - U.width(head) - U.width(cnt) - U.width(tail);
    if (boxW < 6) { tail = ''; boxW = limit - U.width(head) - U.width(cnt); }  // 太窄就先丢说明文字
    boxW = Math.max(4, Math.min(30, boxW));
    const typed = U.truncate(state.filter, Math.max(1, boxW - 1));
    const box = U.padEnd(typed + '▏', boxW);     // ▏ 是兜底光标（硬件光标会盖住它）
    helpCursorCol = U.width(head) + U.width(typed) + 1;   // 1-based 列号
    // 不高亮：标签沿用按键名那套亮青，输入内容用正常前景色，只靠 ▏ 标位置
    const used = U.width(head) + boxW + U.width(cnt) + U.width(tail);
    return C.bg(236) + C.fg(117) + C.bold + head + C.reset + C.bg(236)
      + C.fg(252) + box
      + C.fg(214) + cnt + C.fg(250) + tail
      + ' '.repeat(Math.max(0, limit - used)) + C.reset;
  }
  helpCursorCol = 0;
  let line = '';
  let used = 0;
  // 搜索生效（已按 Enter 确认、不在输入状态）时，把过滤条件摆在提示条最前面：
  // 顶部那行是淡灰小字，一眼看不到；这里只用一个浅暖色标出来，不额外铺背景
  if (state.filter) {
    const tag = ` 搜索「${state.filter}」 ${state.view.length} 首 `;
    const w = U.width(tag);
    if (w <= limit) {
      line += C.fg(215) + tag;
      used += w;
    }
  }
  for (const [key, desc] of helpItems()) {
    const keyTxt = ` ${key} `;
    const descTxt = `${desc} `;
    const w = U.width(keyTxt) + U.width(descTxt);
    if (used + w > limit) break;
    // 按键名亮青加粗，说明浅灰；整行铺深灰底做成状态条，一眼能看出是操作提示
    line += C.fg(117) + C.bold + keyTxt + C.reset + C.bg(236) + C.fg(250) + descTxt;
    used += w;
  }
  return C.bg(236) + line + ' '.repeat(Math.max(0, limit - used)) + C.reset;
}
// 差分重绘：只输出和上一帧不同的行，这样可以做到 20fps 而不闪
let lastFrame = [];
let fullRedraw = false;   // 自检用：整帧输出，方便按行解析
function drawFrame(lines) {
  const C = U.C;
  if (fullRedraw) {
    process.stdout.write(U.home + lines.map((l) => l + C.reset + '\x1b[K').join('\r\n'));
    lastFrame = lines.slice();
    return;
  }
  let buf = '';
  if (lastFrame.length !== lines.length) {
    buf += U.clear + U.home;
    lastFrame = [];
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== lastFrame[i]) {
      buf += `\x1b[${i + 1};1H` + lines[i] + C.reset + '\x1b[K';
    }
  }
  if (buf) process.stdout.write(buf);
  lastFrame = lines.slice();
}

function resetFrame() { lastFrame = []; }

// 进度条那一行：列表视图和歌词视图共用，保证两种视图都能看到进度
function progressLine(cols, pos, dur) {
  const C = U.C;
  const st = backend ? backend.state : 'stopped';
  const icon = st === 'playing' ? '▶' : st === 'paused' ? '‖' : '■';
  const pct = dur > 0 ? Math.round((pos / dur) * 100) : 0;
  const timeTxt = `${U.fmtTime(pos)} / ${U.fmtTime(dur)}`;
  const spd = backend && backend.speed ? backend.speed : 1;
  const spdTxt = `${spd > 0 ? spd : 1}x`;   // 始终显示，让用户知道有倍速这个功能
  const volTxt = backend ? `vol ${backend.volume}` : '';
  // 右侧信息按可用宽度分三档：完整 → 去掉音量 → 只留状态和倍速
  const pctTxt = `${icon} ${String(pct).padStart(3)}% ${spdTxt}`;
  const fixed = 1 + 1 + U.width(timeTxt) + 1;   // 前导空格 + 条与时间之间的空格 + 时间 + 空格
  let rightTxt = volTxt ? `${pctTxt}  ${volTxt}` : pctTxt;
  let barW = cols - 1 - fixed - U.width(rightTxt);
  if (barW < 12 && volTxt) { rightTxt = pctTxt; barW = cols - 1 - fixed - U.width(rightTxt); }
  if (barW < 10) { rightTxt = `${icon} ${spdTxt}`; barW = cols - 1 - fixed - U.width(rightTxt); }
  barW = Math.max(4, barW);
  return ' ' + progressBar(pos, dur, barW) +
    ' ' + C.fg(252) + timeTxt + C.reset +
    ' ' + C.fg(st === 'paused' ? 214 : 114) + rightTxt + C.reset;
}

function renderNowPlaying(out, cols, rows, s, pos, dur) {
  const C = U.C;
  if (!s) {
    out.push('');
    out.push(C.fg(245) + U.center('库里没有音频文件，或目录为空', cols) + C.reset);
    for (let i = 4; i < rows - 1; i++) out.push('');
    return;
  }
  out.push('');
  out.push(' ' + C.bold + C.fg(81) + U.truncate(songLabel(s), cols - 2) + C.reset);

  const artist = songArtist(s);
  const album = (s.meta && s.meta.album) || '';
  const dirTag = s.relDir ? C.fg(238) + `[${s.relDir}]` + C.reset + ' ' : '';
  const line2 = [artist, album].filter(Boolean).join(' · ');
  out.push(' ' + dirTag + C.fg(250) + U.truncate(line2 || s.name, cols - 2 - U.width(dirTag)) + C.reset);
  out.push(' ' + C.fg(244) + U.truncate(fmtInfo(s) || '读取中…', cols - 2) + C.reset);

  out.push(progressLine(cols, pos, dur));
  out.push(' ' + C.fg(237) + '─'.repeat(Math.max(0, cols - 2)) + C.reset);

  // 歌词区
  const top = out.length;
  const bottom = rows - 1;   // 提示行贴最后一行，下面不再留空
  const avail = Math.max(3, bottom - top);
  // 歌词区高度：默认占可用高度的 70%（最少 3 行、最多 14 行），可用 --lyrics-lines 固定
  const area = opts.lyricsLines > 0
    ? Math.min(avail, opts.lyricsLines)
    : Math.min(avail, Math.max(3, Math.min(14, Math.round(avail * 0.7))));
  // 剩余空间上下均分，让歌词块整体居中
  const margin = Math.max(0, Math.floor((avail - area) / 2));
  for (let i = 0; i < margin; i++) out.push('');
  if (!state.lrc) {
    const why = state.lyricsIndex.length === 0 ? '没有找到歌词文件' : '这首歌没有匹配到歌词';
    out.push('');
    out.push(C.fg(242) + U.center(why, cols) + C.reset);
    if (state.lyricsIndex.length) {
      out.push(C.fg(238) + U.center(`已索引 ${state.lyricsIndex.length} 个歌词文件`, cols) + C.reset);
    }
    while (out.length < bottom) out.push('');
    return;
  }

  const idx = currentLrcIndex(pos);
  state.lrcIdx = idx;
  const lines = state.lrc.lines;
  const padTop = lines.length < area ? Math.floor((area - lines.length) / 2) : 0;
  for (let i = 0; i < padTop; i++) out.push('');
  const visArea = Math.max(1, area - padTop);
  const half = Math.floor(visArea / 2);
  const start = Math.max(0, Math.min(idx - half, lines.length - visArea));
  for (let i = 0; i < visArea; i++) {
    const li = start + i;
    const l = lines[li];
    if (!l) { out.push(''); continue; }
    const txt = U.center(U.truncate(l.text, cols - 4), cols - 2);
    if (li === idx) out.push(' ' + C.bold + C.fg(195) + txt + C.reset);
    else out.push(' ' + C.fg(241) + txt + C.reset);
  }
  // 补齐到 bottom，保证提示行永远贴在最后一行
  while (out.length < bottom) out.push('');
}

function renderList(out, cols, rows) {
  const C = U.C;
  const listBottom = rows - 1;
  const s = state.playing;
  const pos = backend ? backend.position : 0;
  const dur = (s && s.meta && s.meta.duration) || (backend && backend.duration) || 0;

  // 当前播放 + 进度条：列表展开也不遮挡（和歌词视图一样始终能看到）
  if (s) {
    const dirTag = s.relDir ? `[${s.relDir}] ` : '';
    const artist = songArtist(s);
    const tail = artist ? ` · ${artist}` : '';
    const budget = Math.max(6, cols - 2 - U.width(dirTag) - U.width(tail));
    out.push(
      ' ' + (s.relDir ? C.fg(238) + `[${s.relDir}]` + C.reset + ' ' : '') +
      C.bold + C.fg(81) + U.truncate(songLabel(s), budget) + C.reset +
      C.fg(250) + tail + C.reset
    );
    out.push(progressLine(cols, pos, dur));
  } else {
    out.push(' ' + C.fg(240) + '未在播放（↑↓ 选曲，Enter 或空格开始）' + C.reset);
  }

  const height = Math.max(1, listBottom - (out.length + 1));
  let start = Math.max(0, state.sel - Math.floor(height / 2));
  if (start + height > state.view.length) start = Math.max(0, state.view.length - height);

  // 宽屏：左列表 + 右歌词，把两边空间用起来；窄屏（<80 列）保持单栏
  const twoCol = cols >= 80;
  const leftW = twoCol ? Math.min(64, Math.max(36, Math.floor(cols * 0.56))) : cols - 2;
  const rightW = twoCol ? cols - leftW - 4 : 0;

  // ---- 左栏：列表 ----
  // 每行只有「标记 序号 名称」；正在播放那行额外带「歌手」。
  // 时长钉在最右 DUR_W 列右对齐 —— 起点只取决于 leftW，不随名称/歌手长度浮动，所以时间永远在同一条竖线上。
  const HEAD = 8;                       // ' ' mark ' ' 序号(3) '  '
  const DUR_W = 7;                      // '03:18' / '--:--' / '1:02:33'
  const durStart = leftW - 1 - DUR_W;   // 时长起点（固定，右边留 1 列避免贴边）
  const nameArea = Math.max(6, durStart - HEAD - 1);
  const listRows = [];
  for (let i = 0; i < height; i++) {
    const si = start + i;
    const it = state.view[si];
    if (!it) { listRows.push(''); continue; }
    const isCur = state.playing && state.playing.path === it.path;
    const isSel = si === state.sel;
    const mark = isCur ? '▶' : ' ';
    const durTxt = it.meta && it.meta.duration ? U.fmtTime(it.meta.duration) : '--:--';

    // 歌手只给正在播放那首，最多 12 列；再窄就把歌手让掉，名称优先
    const artistRaw = songArtist(it);
    let artistW = isCur ? Math.min(12, U.width(artistRaw)) : 0;
    artistW = Math.min(artistW, Math.max(0, nameArea - 6));
    const nameW = Math.max(6, nameArea - (artistW > 0 ? artistW + 1 : 0));

    let mid = U.padEnd(U.truncate(songLabel(it), nameW), nameW);
    if (artistW > 0) mid += ' ' + U.padEnd(U.truncate(artistRaw, artistW), artistW);
    let row = ` ${mark} ${String(si + 1).padStart(3)}  ${mid} ${U.padStart(durTxt, DUR_W)}`;
    if (isSel) row = C.rev + U.padEnd(row, leftW) + C.reset;
    else if (isCur) row = C.fg(114) + row + C.reset;
    listRows.push(row);
  }

  const scope = state.dirFilter ? state.dirFilter : '全部';
  if (!twoCol) {
    out.push(` ${C.fg(244)}${scope} · ${state.view.length} 首${state.filter ? `（搜索：${state.filter}）` : ''}${C.reset}`);
    for (const r of listRows) out.push(r);
    while (out.length < listBottom) out.push('');
    return;
  }

  // ---- 右栏：正在播放这首歌的歌词 ----
  const lyricRows = [];
  const ps = s;
  if (ps && state.lrc) {
    const lines = state.lrc.lines;
    const idx = currentLrcIndex(pos);
    const half = Math.floor(height / 2);
    const ls = Math.max(0, Math.min(idx - half, lines.length - height));
    for (let i = 0; i < height; i++) {
      const l = lines[ls + i];
      if (!l) { lyricRows.push(''); continue; }
      const t = U.center(U.truncate(l.text, Math.max(4, rightW - 2)), rightW);
      if (ls + i === idx) lyricRows.push(C.bold + C.fg(195) + t + C.reset);
      else lyricRows.push(C.fg(241) + t + C.reset);
    }
  } else {
    lyricRows.push(C.fg(240) + U.center(ps ? '这首歌没有歌词' : '没有在播放', rightW) + C.reset);
  }

  // ---- 表头 + 逐行合并 ----
  const headL = U.padEnd(` ${scope} · ${state.view.length} 首`, leftW);
  const headR = ps ? U.truncate(songLabel(ps), rightW) : '';
  out.push(C.fg(244) + headL + C.fg(237) + ' │ ' + C.fg(244) + headR + C.reset);

  for (let i = 0; i < height; i++) {
    const left = listRows[i] ? U.padEnd(listRows[i], leftW) : U.padEnd('', leftW);
    out.push(left + C.fg(237) + ' │ ' + C.reset + (lyricRows[i] || ''));
  }
  while (out.length < listBottom) out.push('');
}
function setFullRedraw(v) { fullRedraw = !!v; }

module.exports = {
  setLive, setFullRedraw,
  currentLrcIndex,
  render, renderHelp, helpItems, drawFrame, resetFrame,
  progressBar, progressLine,
};
