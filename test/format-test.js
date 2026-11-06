'use strict';
// 全格式回归：从库里每种扩展名抽样，用真实后端播一遍，确认位置会前进。
// 运行：node test/format-test.js [音乐目录]
const { MpvBackend, findMpv } = require('../lib/backend-mpv');
const { scan } = require('../lib/library');

const DIR = process.argv[2] || process.env.TP_MUSIC || '';
if (!DIR) { console.log('用法: node test/format-test.js <音乐目录>    （也可以设 TP_MUSIC 环境变量）'); process.exit(1); }
const PER_EXT = 2;          // 每种格式抽几个
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = findMpv();
  if (!exe) { console.log('没找到 mpv'); process.exit(1); }
  const all = scan(DIR);
  const byExt = new Map();
  for (const s of all) {
    if (!byExt.has(s.ext)) byExt.set(s.ext, []);
    if (byExt.get(s.ext).length < PER_EXT) byExt.get(s.ext).push(s);
  }

  console.log(`播放器: ${exe}`);
  console.log(`库: ${DIR}  共 ${all.length} 首, ${byExt.size} 种格式\n`);

  const b = new MpvBackend({ exe, volume: 0 });
  let ok = 0;
  let bad = 0;
  const failures = [];

  for (const [ext, songs] of [...byExt.entries()].sort()) {
    for (const s of songs) {
      try {
        await b.load(s.path, 300, 5);
        await sleep(600);
        const pos = b.position;
        const alive = b.state === 'playing';
        if (alive && pos > 4.5) {
          ok++;
          console.log(`  ✓ ${ext.padEnd(5)} pos=${pos.toFixed(1).padStart(5)}  ${s.name.slice(0, 60)}`);
        } else {
          bad++;
          const why = `${ext} state=${b.state} pos=${pos.toFixed(1)}`;
          failures.push(why + '  ' + s.name);
          console.log(`  ✗ ${why}  ${s.name.slice(0, 60)}`);
        }
      } catch (e) {
        bad++;
        failures.push(`${ext} ${s.name}: ${e.message.slice(0, 100)}`);
        console.log(`  ✗ ${ext} 异常: ${e.message.slice(0, 100)}  ${s.name.slice(0, 50)}`);
      }
    }
  }

  b.dispose();
  console.log(`\n结果: ${ok} 通过 / ${bad} 失败（${byExt.size} 种格式）`);
  if (failures.length) {
    console.log('失败明细:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(bad ? 1 : 0);
})();
