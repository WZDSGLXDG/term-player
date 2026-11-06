'use strict';
// 曲目显示名与信息行：纯函数，不读全局状态、不碰磁盘
const U = require('./ui');

// 还没探测到元数据时用的显示名：文件名常是「01. 歌名 - 歌手 - 专辑」，
// 整串甩进列表又长又乱（还跟探测过的歌风格不一致），只留歌名。
// 切分规则和 lib/lyrics.js 的 keysOf 一致：- / – / — 都算分隔，有没有空格都切。
function displayName(base) {
  const raw = String(base || '').trim();
  if (!raw) return raw;
  let t = raw.replace(/^\s*\d{1,3}\s*[-._、)．\]]\s*/, '');   // 前导编号 01. / 02 - / 03_
  const parts = t.split(/\s*[-–—]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0]) t = parts[0];
  return t || raw;
}

function songLabel(s) {
  const m = s.meta;
  if (m && m.title) return m.title;
  return displayName(s.base);
}

function songArtist(s) {
  return (s.meta && s.meta.artist) || '';
}

function fmtInfo(s) {
  const m = s.meta;
  if (!m || !m.ok) return '';
  const bits = [];
  if (m.codec) bits.push(m.codec.toUpperCase());
  if (m.sampleRate) bits.push((m.sampleRate / 1000).toFixed(1).replace('.0', '') + 'kHz');
  if (m.channels) bits.push(m.channels === 1 ? '单声道' : m.channels === 2 ? '立体声' : m.channels + 'ch');
  if (m.bitrate) bits.push(Math.round(m.bitrate / 1000) + 'kbps');
  if (s.size) bits.push(U.fmtSize(s.size));
  return bits.join(' · ');
}

module.exports = { displayName, songLabel, songArtist, fmtInfo };
