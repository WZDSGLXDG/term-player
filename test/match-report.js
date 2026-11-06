'use strict';
// 真实库的歌词匹配报表：node test/match-report.js "<音乐目录>"
const path = require('path');
const { scan } = require('../lib/library');
const lyrics = require('../lib/lyrics');

const DIR = process.argv[2] || process.env.TP_MUSIC || '';
if (!DIR) { console.log('用法: node test/match-report.js <音乐目录> [额外的歌词目录]    （也可以设 TP_MUSIC）'); process.exit(1); }
const extra = process.argv.slice(3);
const dirs = [DIR, path.join(DIR, '歌词'), path.join(DIR, 'lyrics'), ...extra];
const songs = scan(DIR, { recursive: true });
const index = lyrics.buildIndex(dirs);

const hits = [];
const miss = [];
for (const s of songs) {
  const h = lyrics.match(s, index);
  if (h) hits.push({ song: s, hit: h });
  else miss.push(s);
}

const pct = ((hits.length / songs.length) * 100).toFixed(1);
console.log(`歌曲 ${songs.length} · 歌词库 ${index.length} · 命中 ${hits.length} (${pct}%) · 未命中 ${miss.length}`);
console.log('');
console.log('=== 命中明细（前 30，按分数） ===');
const sorted = hits.slice().sort((a, b) => b.hit.score - a.hit.score);
for (const { song, hit } of sorted.slice(0, 30)) {
  console.log(`  ${String(hit.score).padStart(3)}  ${song.name}`);
  console.log(`       → ${path.basename(hit.file)}`);
}
console.log('');
console.log('=== 未命中（前 30） ===');
for (const s of miss.slice(0, 30)) {
  console.log(`  ${s.name}   [${path.basename(path.dirname(s.path))}]`);
}
console.log('');
console.log('=== 分数分布 ===');
const dist = {};
for (const { hit } of hits) {
  const b = hit.score >= 100 ? '100 精确' : hit.score >= 90 ? '90 归一化' : hit.score >= 80 ? '80 标题' : '40-60 包含';
  dist[b] = (dist[b] || 0) + 1;
}
for (const [k, v] of Object.entries(dist).sort()) console.log(`  ${k}: ${v}`);
