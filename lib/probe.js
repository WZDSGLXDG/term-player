'use strict';
// ffprobe 元数据读取：内存缓存 → 磁盘缓存（size+mtime 校验）→ 真正起进程
// 磁盘缓存的意义：158 首的库，第二次启动 0 次 ffprobe（首次要 158 次）。
const { execFile } = require('child_process');
const fs = require('fs');

const cache = new Map();   // file -> Promise<meta>
const disk = new Map();    // file -> { size, mtimeMs, meta }
let diskPath = null;
let diskDirty = false;
let flushTimer = null;

const stats = { spawns: 0, memHits: 0, diskHits: 0, stale: 0, errors: 0 };

// ---- 磁盘缓存 ----
function openDisk(p) {
  diskPath = p || null;
  disk.clear();
  if (!diskPath) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
    const files = (j && j.files) || {};
    for (const [k, v] of Object.entries(files)) {
      if (v && v.meta && v.meta.ok && typeof v.size === 'number' && typeof v.mtimeMs === 'number') disk.set(k, v);
    }
  } catch { /* 首次运行 / 文件坏了：当空缓存 */ }
  return disk.size;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 2000);
  if (flushTimer.unref) flushTimer.unref();
}

function flushNow() {
  if (!diskPath || !diskDirty) return false;
  const files = {};
  for (const [k, v] of disk) files[k] = v;
  const tmp = diskPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, files }), 'utf8');
    fs.renameSync(tmp, diskPath);   // 临时文件 → 校验 → 替换，避免写一半留坏缓存
    diskDirty = false;
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 无所谓 */ }
    return false;
  }
}

function remember(file, st, meta) {
  if (!st || !meta || !meta.ok) return;
  disk.set(file, { size: st.size, mtimeMs: st.mtimeMs, meta });
  diskDirty = true;
  scheduleFlush();
}

// ---- 探测 ----
function runProbe(ffprobe, file, st) {
  stats.spawns++;
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries',
        'stream=codec_name,sample_rate,channels,bit_rate,bits_per_raw_sample:format=duration,bit_rate,size:format_tags=title,artist,album,track,date',
        '-of', 'json',
        file,
      ],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 8000, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) { stats.errors++; return resolve({ ok: false, error: err.message }); }
        let j;
        try { j = JSON.parse(stdout); } catch { stats.errors++; return resolve({ ok: false, error: 'bad json' }); }
        const s = (j.streams && j.streams[0]) || {};
        const f = j.format || {};
        const tags = {};
        for (const [k, v] of Object.entries(f.tags || {})) tags[k.toLowerCase()] = v;
        resolve({
          ok: true,
          codec: s.codec_name || '',
          sampleRate: Number(s.sample_rate) || 0,
          channels: Number(s.channels) || 0,
          streamBitrate: Number(s.bit_rate) || 0,
          duration: Number(f.duration) || 0,
          bitrate: Number(f.bit_rate) || 0,
          size: Number(f.size) || 0,
          title: tags.title || '',
          artist: tags.artist || '',
          album: tags.album || '',
          track: tags.track || '',
          date: tags.date || '',
        });
      }
    );
  }).then((meta) => {
    remember(file, st, meta);
    return meta;
  });
}

function probe(ffprobe, file) {
  if (cache.has(file)) { stats.memHits++; return cache.get(file); }

  let st = null;
  try { st = fs.statSync(file); } catch { st = null; }

  // 磁盘命中：文件大小和修改时间都没变才算数
  const d = disk.get(file);
  if (d && st && d.meta && d.meta.ok && st.size === d.size && Math.abs(st.mtimeMs - d.mtimeMs) < 1) {
    stats.diskHits++;
    const p = Promise.resolve(d.meta);
    cache.set(file, p);
    return p;
  }
  if (d) stats.stale++;

  const p = runProbe(ffprobe, file, st);
  cache.set(file, p);
  // 失败结果不留在内存缓存里：一次瞬时失败（文件被占用、杀软扫描）不该让这首歌
  // 整场运行都停在"读取中…"、进度条恒为 0:00。下次进可见窗口会重试。
  p.then((meta) => { if (!meta || !meta.ok) { if (cache.get(file) === p) cache.delete(file); } },
    () => { if (cache.get(file) === p) cache.delete(file); });
  return p;
}

function forget(file) {
  cache.delete(file);
  if (disk.delete(file)) { diskDirty = true; scheduleFlush(); }
}

function clear() { cache.clear(); }

function resetStats() { stats.spawns = 0; stats.memHits = 0; stats.diskHits = 0; stats.stale = 0; stats.errors = 0; }

module.exports = {
  probe, forget, clear, stats, resetStats,
  openDisk, flushNow,
  diskSize: () => disk.size,
};
