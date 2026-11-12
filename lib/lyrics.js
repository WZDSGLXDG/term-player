'use strict';
// LRC 歌词：解析 + 跨文件夹匹配
// 匹配优先级：同名 > 归一化同名 > 元数据标题 > 互相包含
const fs = require('fs');
const path = require('path');

const LRC_EXT = new Set(['.lrc', '.txt', '.lrc8', '.ksc']);

// ---------- 文本解码：先严格 UTF-8，失败退回 GB18030 ----------
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.slice(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.slice(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { /* 不是合法 UTF-8 */ }
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch { /* 没有 ICU */ }
  return buf.toString('latin1');
}

// ---------- 归一化：去掉编号、括号内容、标点、空格，统一小写 ----------
function norm(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  t = t.replace(/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|ape|wv|tta|tak|dsf|dff|aif|aiff|lrc|txt)$/i, '');
  t = t.replace(/^\s*\d{1,3}\s*[-._、)．\]]\s*/, '');      // 前导编号 01. / 02 - / 03_
  t = t.replace(/[\(（\[【].*?[\)）\]】]/g, ' ');            // 各种括号内容
  t = t.replace(/\b(feat|ft)\.?\s+.+$/i, '');              // feat. 之后
  t = t.replace(/[\s\u3000]+/g, '');
  t = t.replace(/[_\-—–·、，,。.。'"'`"!！?？~～:：;；\/\\|]/g, '');
  return t.trim();
}

// 一个名字生成多个候选键，提高命中率
function keysOf(name) {
  const keys = new Set();
  const full = norm(name);
  if (full) keys.add(full);

  // 常见命名是「歌名 - 歌手 - 专辑」，歌词和歌曲的尾段经常不一致，
  // 所以额外生成「只要歌名」和「歌名+歌手」两个键，让两边能对上。
  const parts = String(name)
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .split(/\s*[-–—]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const titleOnly = norm(parts[0]);
    if (titleOnly.length >= 2) keys.add(titleOnly);
    const titleArtist = norm(parts[0] + ' ' + parts[1]);
    if (titleArtist) keys.add(titleArtist);
  }
  return [...keys];
}

// ---------- LRC 解析 ----------
function parseLrc(text) {
  const tsRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const meta = {};
  const lines = [];
  let offsetMs = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // 标签行 [ti:xxx]
    const tag = line.match(/^\[(ti|ar|al|by|offset|length|au|re|ve):(.*)\]$/i);
    if (tag) {
      const k = tag[1].toLowerCase();
      const v = tag[2].trim();
      meta[k] = v;
      // 多个 [offset:] 时后面的覆盖前面的（规范里只该有一个，按最后出现的算）
      if (k === 'offset') {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) offsetMs = n;
      }
      continue;
    }

    // 收集本行所有时间戳
    const stamps = [];
    let m;
    tsRe.lastIndex = 0;
    let rest = line;
    while ((m = tsRe.exec(line)) !== null) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      let ms = 0;
      if (m[3]) {
        const frac = m[3];
        ms = frac.length === 1 ? parseInt(frac, 10) * 100
          : frac.length === 2 ? parseInt(frac, 10) * 10
            : parseInt(frac, 10);
      }
      stamps.push(mm * 60 + ss + ms / 1000);
    }
    if (stamps.length === 0) continue;

    // 去掉时间戳后剩下的是歌词正文
    const body = line.replace(tsRe, '').trim();
    if (!body) continue;
    // src（原始行文本）没人读，删掉：136 首歌的歌词全量解析时这部分白占内存
    for (const t of stamps) lines.push({ t, text: body });
  }

  // 应用 offset（LRC 规范：正值表示歌词提前）
  if (offsetMs !== 0) {
    for (const l of lines) {
      l.t = Math.max(0, l.t - offsetMs / 1000);
    }
  }

  lines.sort((a, b) => a.t - b.t);
  return { lines, meta, offsetMs };
}

// ---------- 歌词库索引 ----------
function walkLrc(dir, out, depth) {
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walkLrc(full, out, depth + 1);
    } else if (e.isFile() && LRC_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// 解析结果按「路径 + mtime + 大小」缓存。
// 改一个 .lrc 时只重解析那一个，不用把库里的文件全读一遍
// （实测 175 个文件全量 62ms，增量 1 个约 1.6ms —— 重新加载歌词不再卡掉一帧）。
const parseCache = new Map();   // 小写绝对路径 -> { mtimeMs, size, item }
let lastStats = { files: 0, parsed: 0, reused: 0 };

function buildIndex(dirs, { force = false } = {}) {
  const files = [];
  const seen = new Set();
  for (const d of dirs || []) {
    const batch = [];
    try { walkLrc(d, batch, 0); } catch { /* 目录不存在就跳过 */ }
    for (const f of batch) {
      // 目录可能互相嵌套（音乐目录递归扫到「歌词」子目录），按小写全路径去重
      const key = path.resolve(f).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(f);
    }
  }

  const index = [];
  const alive = new Set();
  let parsed = 0;
  let reused = 0;

  for (const file of files) {
    const key = path.resolve(file).toLowerCase();
    let st = null;
    try { st = fs.statSync(file); } catch { continue; }   // 文件没了：不进 alive，缓存随后清掉
    alive.add(key);

    const hit = force ? null : parseCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      index.push(hit.item);
      reused++;
      continue;
    }

    const stem = path.basename(file, path.extname(file));
    let parsedLrc = null;
    try {
      const text = decodeText(fs.readFileSync(file));
      parsedLrc = parseLrc(text);
    } catch {
      continue;
    }
    // 没有时间轴的 .txt 不算歌词
    if (!parsedLrc.lines || parsedLrc.lines.length === 0) continue;

    const item = {
      file,
      stem,
      keys: keysOf(stem),
      title: norm(parsedLrc.meta.ti || ''),
      artist: norm(parsedLrc.meta.ar || ''),
      lineCount: parsedLrc.lines.length,
      parsed: parsedLrc,
    };
    parseCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, item });
    index.push(item);
    parsed++;
  }

  // 被删/改名的文件，缓存条目跟着清，否则只增不减
  for (const k of [...parseCache.keys()]) if (!alive.has(k)) parseCache.delete(k);

  lastStats = { files: files.length, parsed, reused };
  return index;
}

// 上一次 buildIndex 干了多少活：测试和自检靠它验证增量真的生效了
function buildStats() { return { ...lastStats }; }

// 测试用：丢掉缓存
function clearIndexCache() { parseCache.clear(); }

// ---------- 匹配 ----------
function match(song, index) {
  if (!index || index.length === 0) return null;
  const songKeys = new Set([
    norm(song.base),
    norm(song.name),
    song.meta && song.meta.title ? norm(song.meta.title) : '',
    ...keysOf(song.base),
    ...(song.meta && song.meta.title ? keysOf(song.meta.title) : []),
  ].filter(Boolean));

  let best = null;
  let bestScore = 0;

  for (const item of index) {
    let score = 0;

    // 1. 文件名完全一致
    if (item.stem.toLowerCase() === song.base.toLowerCase()) score = 100;

    // 2. 归一化键命中
    if (score < 90) {
      for (const k of item.keys) {
        if (songKeys.has(k)) { score = Math.max(score, 90); break; }
      }
    }

    // 3. 元数据标题命中
    if (score < 80 && item.title) {
      for (const k of songKeys) {
        if (k === item.title) { score = Math.max(score, 80); break; }
      }
    }

    // 4. 互相包含（长度 >= 2 才算）
    if (score < 60) {
      for (const k of item.keys) {
        if (k.length < 2) continue;
        for (const sk of songKeys) {
          if (sk.length < 2) continue;
          if (sk === k) { score = Math.max(score, 75); break; }
          if (sk.includes(k) || k.includes(sk)) {
            const ratio = Math.min(sk.length, k.length) / Math.max(sk.length, k.length);
            if (ratio >= 0.6) score = Math.max(score, 40 + Math.round(ratio * 20));
          }
        }
      }
    }

    // 同分时取歌词更完整的
    if (score > bestScore || (score === bestScore && best && item.lineCount > best.lineCount)) {
      bestScore = score;
      best = item;
    }
  }

  if (!best || bestScore < 40) return null;
  return { ...best, score: bestScore };
}

module.exports = {
  parseLrc, buildIndex, match, norm, keysOf, decodeText,
  buildStats, clearIndexCache,
};
