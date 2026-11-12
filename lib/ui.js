'use strict';
// ANSI 渲染工具：中英混排按显示宽度计算（中文占 2 列）
// 制表符按固定 4 列算。终端会把它跳到下一个制表位（1~8 列视当前位置而定），
// 不展开的话 width() 说 0 列、实际多占几列，右边的时间列就跟同屏其他行错开了。
const TAB_WIDTH = 4;
function expandTabs(s) {
  return s.indexOf('\t') === -1 ? s : s.replace(/\t/g, ' '.repeat(TAB_WIDTH));
}

function charWidth(cp) {
  // 零宽字符：零宽连接符 / 变体选择符 / 组合附加符号。
  // 这一组必须排在宽字符判断**之前** —— 日文浊点 U+3099/U+309A 落在 CJK 区间里，
  // 排后面就会把 NFD 的「が」(U+304B+U+3099) 算成 4 列（实际显示 2 列）。
  if (
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0x3099 && cp <= 0x309a) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) return 0;
  if (cp < 32) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f650 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function width(str) {
  let w = 0;
  for (const ch of expandTabs(str)) w += charWidth(ch.codePointAt(0));
  return w;
}

// 按显示宽度截断，超出部分用 … 表示
function truncate(str, max, ellipsis = '…') {
  if (max <= 0) return '';
  str = expandTabs(str);   // \t 先摊成空格：算宽度和真正输出的必须是同一个串
  if (width(str) <= max) return str;
  const ellW = width(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - ellW) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

function padEnd(str, w) {
  str = expandTabs(str);
  const cur = width(str);
  return cur >= w ? str : str + ' '.repeat(w - cur);
}

function padStart(str, w) {
  str = expandTabs(str);
  const cur = width(str);
  return cur >= w ? str : ' '.repeat(w - cur) + str;
}

function center(str, w) {
  str = expandTabs(str);
  const cur = width(str);
  if (cur >= w) return truncate(str, w);
  const left = Math.floor((w - cur) / 2);
  return ' '.repeat(left) + str + ' '.repeat(w - cur - left);
}

// （原来的 bar() 已删除：player.js 有自己的 progressBar，两套取整方式不一致，留着只会误导）

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + 'G';
  if (bytes > 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + 'M';
  return Math.round(bytes / 1024) + 'K';
}

// 颜色
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  rev: '\x1b[7m',
  fg: (n) => `\x1b[38;5;${n}m`,
  bg: (n) => `\x1b[48;5;${n}m`,
};

const enterAlt = '\x1b[?1049h';
const leaveAlt = '\x1b[?1049l';
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';
const clear = '\x1b[2J';
const home = '\x1b[H';

module.exports = {
  width, truncate, padEnd, padStart, center, fmtTime, fmtSize,
  C, enterAlt, leaveAlt, hideCursor, showCursor, clear, home,
};
