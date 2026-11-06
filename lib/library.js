'use strict';
// 音乐库扫描：递归列出音频文件，按路径稳定排序，并记录所属分类文件夹
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav',
  '.wma', '.ape', '.wv', '.tta', '.tak', '.dsf', '.dff', '.aiff', '.aif',
  '.mp2', '.mka', '.ac3', '.dts', '.mid', '.mod', '.xm', '.it', '.s3m',
]);

const SKIP_DIR = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git']);

function isAudio(file) {
  return AUDIO_EXT.has(path.extname(file).toLowerCase());
}

function walk(dir, root, recursive, out, depth) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!recursive) continue;
      if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      walk(full, root, recursive, out, depth + 1);
    } else if (e.isFile() && isAudio(e.name)) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      // 相对根目录的第一层文件夹名 = 分类（用户按文件夹区分曲风）
      const rel = path.relative(root, dir);
      const relDir = !rel || rel === '.' ? '' : rel.split(path.sep)[0];
      out.push({
        path: full,
        base: path.basename(full, path.extname(full)),
        name: e.name,
        ext: path.extname(full).toLowerCase(),
        relDir,
        relPath: path.relative(root, full),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return out;
}

function scan(dir, opts = {}) {
  const recursive = opts.recursive !== false;
  const root = path.resolve(dir);
  const files = walk(root, root, recursive, [], 0);
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
  return files;
}

// 按分类汇总：{ '(全部)': n, '流行': 37, ... }，顺序按首次出现
function groupByDir(songs) {
  const map = new Map();
  for (const s of songs) {
    const k = s.relDir || '(根目录)';
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

module.exports = { scan, groupByDir, isAudio, AUDIO_EXT };
