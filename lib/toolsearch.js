'use strict';
// 零依赖的可执行文件定位：PATH 解析 + "存在且是文件"的判断。
// 具体候选顺序留给调用方（findTool / findMpv 各有各的优先级），这里只提供公共底座，
// 免得改这里把别人的探测顺序挪了。
const fs = require('fs');
const path = require('path');

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

// PATH 里的目录（跳过空项，Windows 上 PATH 常以 ; 结尾）
function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

// 按给定顺序返回第一个存在的文件，都没有返回 null
function firstFile(cands) {
  for (const c of cands) if (isFile(c)) return c;
  return null;
}

module.exports = { isFile, pathDirs, firstFile };
