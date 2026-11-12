'use strict';
// 零依赖单元测试：按键映射、参数解析、歌词时序、渲染宽度
// 运行：node test/run-tests.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const P = require('../player.js');
const U = require('../lib/ui');
const lyrics = require('../lib/lyrics');

P.setPersist(false);   // 测试绝不碰用户的 config.json
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function eq(a, b, name) { ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

// ---------- 桩后端 ----------
function makeStub() {
  return {
    volume: 80, state: 'playing', file: 'C:\\x.mp3', duration: 30, position: 10,
    calls: [],
    toggle() { this.calls.push('toggle'); this.state = this.state === 'playing' ? 'paused' : 'playing'; },
    seek(t) { this.calls.push('seek:' + Number(t).toFixed(1)); this.position = t; },
    setVolume(v) { this.volume = v; this.calls.push('vol:' + v); },
    load(f, d, s) { this.calls.push('load'); this.file = f; this.duration = d; this.position = s || 0; },
    stop() { this.calls.push('stop'); },
    pause() { this.calls.push('pause'); },
    resume() { this.calls.push('resume'); },
    dispose() { this.calls.push('dispose'); },
  };
}

const tmp = path.join(os.tmpdir(), 'tp-test-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'music'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'lrc'), { recursive: true });
// 造两个假音频文件（只验证扫描，不解码）
fs.writeFileSync(path.join(tmp, 'music', '01. A歌.mp3'), Buffer.alloc(1024));
fs.writeFileSync(path.join(tmp, 'music', 'B歌.flac'), Buffer.alloc(1024));
fs.writeFileSync(path.join(tmp, 'lrc', 'A歌.lrc'), '[00:01.00]第一行\n[00:05.50]第二行\n[00:09.00]第三行\n');

console.log('== 参数解析 ==');
{
  const o = P.parseArgs(['D:\\Music', '--lyrics', 'D:\\lrc1', '-l', 'D:\\lrc2', '--volume', '55', '--no-recursive', '--start', '12.5']);
  eq(o.dir, 'D:\\Music', '目录');
  eq(o.lyricsDirs.length, 2, '两个歌词目录');
  eq(o.volume, 55, '音量');
  eq(o.recursive, false, '非递归');
  eq(o.start, 12.5, '起始位置');
  eq(P.parseArgs(['--mode', 'shuffle']).playMode, 'shuffle', '--mode 参数');
  eq(P.parseArgs(['-m', 'One']).playMode, 'one', '-m 大小写归一');
}

console.log('\n== 按键序列解析 ==');
{
  eq(P.splitKeys('\x1b[C').join('|'), '\x1b[C', '右箭头');
  eq(P.splitKeys('ab').join('|'), 'a|b', '两个普通键');
  eq(P.splitKeys('\x1b[5~').join('|'), '\x1b[5~', 'PgUp');
  eq(P.splitKeys(' \x1b[D').length, 2, '空格+左箭头 = 2 个键');
}

console.log('\n== 库扫描 ==');
P.setOpts({ dir: path.join(tmp, 'music'), recursive: true, lyricsDirs: [], volume: 80, start: 0 });
P.setLyricDirs([path.join(tmp, 'lrc')]);
P.setBackend(makeStub());
P.state.playing = null;
P.state.filter = '';
P.rescan(false);
eq(P.state.songs.length, 2, '扫描到 2 首');
eq(P.state.view.length, 2, '视图 2 首');

console.log('\n== 按键行为 ==');
{
  const b = P.getBackend();
  b.calls.length = 0;
  P.handleKey(' ');
  ok(b.calls.includes('toggle'), '空格 → toggle 播放/暂停');

  b.position = 10;
  b.calls.length = 0;
  P.handleKey('\x1b[C');
  ok(b.calls.some((c) => c === 'seek:15.0'), '右箭头 → seek +5s', b.calls.join(','));

  b.calls.length = 0;
  P.handleKey('\x1b[D');
  ok(b.calls.some((c) => c === 'seek:10.0'), '左箭头 → seek -5s', b.calls.join(','));

  b.calls.length = 0;
  P.handleKey('+');
  eq(b.volume, 85, '加号 → 音量 +5');
  P.handleKey('-');
  eq(b.volume, 80, '减号 → 音量 -5');

  P.state.sel = 0;
  P.handleKey('j');
  eq(P.state.sel, 1, 'j → 选中下移');
  P.handleKey('k');
  eq(P.state.sel, 0, 'k → 选中上移');
  P.handleKey('G');
  eq(P.state.sel, 1, 'G → 末尾');
  P.handleKey('g');
  eq(P.state.sel, 0, 'g → 开头');

  const modeBefore = P.state.viewMode;
  P.handleKey('l');
  ok(P.state.viewMode !== modeBefore, 'l → 切换视图');
  P.handleKey('l');

  // 边界：选中不能越界
  P.state.sel = 0;
  P.handleKey('k');
  eq(P.state.sel, 0, '首项再上移不越界');
}

console.log('\n== 搜索过滤 ==');
{
  P.handleKey('/');
  ok(P.state.inputMode === true, '/ → 进入输入模式');
  P.handleKey('B');
  eq(P.state.filter, 'B', '输入字符进入过滤条件（保留原样，比较时转小写）');
  eq(P.state.view.length, 1, '过滤后 1 首');
  P.handleKey('\x7f');
  eq(P.state.filter, '', '退格删除');
  eq(P.state.view.length, 2, '退格后恢复 2 首');
  P.handleKey('\r');
  ok(P.state.inputMode === false, 'Enter → 退出输入模式');
}

console.log('\n== 歌词时序 ==');
{
  const lrc = fs.readFileSync(path.join(tmp, 'lrc', 'A歌.lrc'), 'utf8');
  const parsed = lyrics.parseLrc(lrc);
  eq(parsed.lines.length, 3, '解析 3 行歌词');
  ok(Math.abs(parsed.lines[1].t - 5.5) < 1e-6, '第二行时间 5.5s');
  P.state.lrc = { lines: parsed.lines, meta: parsed.meta };
  eq(P.currentLrcIndex(0.5), -1, '0.5s 还没到第一行');
  eq(P.currentLrcIndex(1.0), 0, '1s 命中第一行');
  eq(P.currentLrcIndex(6.0), 1, '6s 命中第二行');
  eq(P.currentLrcIndex(100), 2, '超出后停在最后一行');
}

console.log('\n== 歌词匹配 ==');
{
  const idx = lyrics.buildIndex([path.join(tmp, 'lrc')]);
  eq(idx.length, 1, '索引 1 个歌词文件');
  const songA = { base: '01. A歌', name: '01. A歌.mp3', path: 'x', meta: null };
  const hitA = lyrics.match(songA, idx);
  ok(hitA && hitA.score <= 100, '带编号的歌名能归一化命中');
  const songC = { base: '完全无关的歌', name: '完全无关的歌.mp3', path: 'y', meta: null };
  ok(lyrics.match(songC, idx) === null, '无关歌曲不误配');
}

console.log('\n== 刷新后光标位置 ==');
{
  // 曲库/歌词刷新会重建视图：光标必须跟着「那首歌」走，不能跳回正在播放的位置
  const saved = P.state.playing;
  P.rescan(false);
  P.state.playing = P.state.view[0];
  P.state.sel = P.state.view.length - 1;    // 翻到最后一首（离播放位置最远）
  const target = P.state.view[P.state.sel].path;
  // 伪造一次文件变化，逼 rescan 真走重建路径——否则会被「没变就跳过」提前返回，这条就成了空过
  P.state.songs[0].size = -1;
  P.rescan(true);                           // 模拟一次刷新
  eq(P.state.view[P.state.sel].path, target, '刷新后光标留在原来那首（不跳回播放位置）');
  eq(P.state.playing.path, P.state.view[0].path, '刷新不影响正在播放的那首');
  P.state.playing = saved;
}

// 「没变就跳过」：改一个 .lrc 会连带触发 rescan，不该把整个库重建一遍
{
  P.rescan(false);
  const ref = P.state.songs;
  P.state.songs[0].meta = { title: '已经探测过' };
  eq(P.rescan(true), false, '曲库没变 → rescan 返回 false');
  ok(P.state.songs === ref, '曲库没变 → songs 数组没被重建');
  eq((P.state.songs[0].meta || {}).title, '已经探测过', '曲库没变 → 已探测的元数据还在');
}

// 真的变了才值得重建
{
  P.rescan(false);
  const before = P.state.songs;
  P.state.songs[0].size = -1;
  eq(P.rescan(true), true, '文件有变化 → rescan 返回 true');
  ok(P.state.songs !== before, '文件有变化 → songs 被重建');
}

console.log('\n== 分类切换 ==');
{
  P.state.dirFilter = null;
  P.applyFilter();
  const total = P.state.view.length;
  ok(P.state.dirs.length >= 1, '识别出分类', '共 ' + P.state.dirs.length + ' 个');
  P.cycleDir(1);
  ok(P.state.dirFilter !== null, 'cycleDir 切到具体分类', String(P.state.dirFilter));
  ok(P.state.view.every((s) => (s.relDir || '(根目录)') === P.state.dirFilter), '视图只剩该分类的曲目');
  P.cycleDir(-1);
  ok(P.state.dirFilter === null, 'cycleDir 转回全部');
  eq(P.state.view.length, total, '回到全部后曲目数一致');
}

console.log('\n== 播放模式 ==');
{
  eq(P.PLAY_MODES.map((m) => m.id).join('>'), 'all>one>shuffle', '三种模式：循环/单曲/随机');
  eq(P.PLAY_MODES.some((m) => m.id === 'seq'), false, '「顺序」已移除（旧 config 里的 seq 会被忽略 → 回落到循环）');
  eq(P.nextPlayModeId('all', 1), 'one', 'm：循环 → 单曲');
  eq(P.nextPlayModeId('shuffle', 1), 'all', 'm：随机 绕回 循环');
  eq(P.nextPlayModeId('all', -1), 'shuffle', 'M：循环 反向到 随机');
  eq(P.nextPlayModeId('one', -1), 'all', 'M：单曲 反向到 循环');

  // 用 5 首假视图测下标选择，不碰真实状态
  const savedView = P.state.view;
  const savedMode = P.state.playMode;
  const savedPlaying = P.state.playing;
  const savedSel = P.state.sel;
  const view = [];
  for (let i = 0; i < 5; i++) view.push({ path: 'p' + i, name: 's' + i, base: 's' + i, meta: { duration: 60 } });
  P.state.view = view;
  P.state.sel = 4;
  P.state.playing = view[4];

  P.state.playMode = 'all';
  eq(P.nextIndex(1, false), 0, '循环：手动 n 在最后一首绕回第一首');
  eq(P.nextIndex(1, true), 0, '循环：最后一首播完回到第一首（不会再停）');
  eq(P.nextIndex(-1, false), 3, '循环：p 退一首');
  eq(P.nextIndex(-1, true), 3, '循环：p 一直退也是循环');

  eq(P.nextIndex(1, true), 0, '空视图之外：有歌时永远有下一首（-1 只表示空列表）');

  P.state.playMode = 'one';
  eq(P.nextIndex(1, true), 4, '单曲：播完还是这一首');
  eq(P.nextIndex(1, false), 0, '单曲：手动 n 照样切下一首');

  P.state.playMode = 'shuffle';
  P.state.shuffleDeck = [];
  P.state.playing = view[2];
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(P.nextIndex(1, true));
  ok(picks.every((k) => k >= 0 && k < 5), '随机：40 次取到的下标都合法', picks.join(','));
  ok(new Set(picks).size >= 3, '随机：确实会换歌而不是原地打转', '不同 ' + new Set(picks).size + ' 首');
  let same = 0;
  for (let i = 1; i < picks.length; i++) if (picks[i] === 2 && picks[i - 1] === 2) same++;
  ok(same <= 1, '随机：连续重播自己最多 1 次', '连续重复 ' + same + ' 次');

  P.state.shuffleDeck = [];
  const deck = P.refillShuffleDeck(2);
  eq(deck.length, 5, '随机：洗牌队列长度 = 曲目数');
  eq(deck[deck.length - 1], 2, '随机：当前这首排在牌堆最底（最后才可能重播）');

  P.state.playMode = 'shuffle';
  eq(P.helpItems().find((it) => it[0] === 'm')[1], '随机', '提示条 m 项显示当前模式');
  P.state.playMode = 'one';
  eq(P.helpItems().find((it) => it[0] === 'm')[1], '单曲', '换模式后提示条跟着变');

  P.state.view = savedView;
  P.state.playMode = savedMode;
  P.state.playing = savedPlaying;
  P.state.sel = savedSel;
  P.state.shuffleDeck = [];
}

console.log('\n== 元数据磁盘缓存 ==');
const asyncChecks = (async () => {
  const probeMod = require('../lib/probe');
  const cacheFile = path.join(tmp, 'meta-cache.json');
  const f = path.join(tmp, 'music', '01. A歌.mp3');
  const st = fs.statSync(f);

  // 伪造一条命中记录：size / mtime 与真实文件一致
  fs.writeFileSync(cacheFile, JSON.stringify({
    v: 1,
    files: { [f]: { size: st.size, mtimeMs: st.mtimeMs, meta: { ok: true, duration: 999, codec: 'cached' } } },
  }), 'utf8');

  probeMod.clear();
  eq(probeMod.openDisk(cacheFile), 1, '磁盘缓存载入 1 条');
  probeMod.resetStats();
  const hit = await probeMod.probe('ffprobe-not-needed', f);
  eq(hit.duration, 999, 'size+mtime 一致 → 直接用缓存，不起 ffprobe');
  eq(probeMod.stats.spawns, 0, '命中时 ffprobe 起进程数 = 0');
  eq(probeMod.stats.diskHits, 1, '统计里记了一次 diskHit');

  // 文件变了 → 缓存作废，必须重新探（这里故意用不存在的 ffprobe，走失败分支）
  const st2 = { size: st.size + 1, mtimeMs: st.mtimeMs };
  fs.writeFileSync(cacheFile, JSON.stringify({
    v: 1,
    files: { [f]: { size: st2.size, mtimeMs: st2.mtimeMs, meta: { ok: true, duration: 111 } } },
  }), 'utf8');
  probeMod.clear();
  probeMod.openDisk(cacheFile);
  probeMod.resetStats();
  const miss = await probeMod.probe('ffprobe-not-needed', f);
  eq(miss.ok, false, 'size 对不上 → 缓存作废，重新探测');
  ok(probeMod.stats.spawns >= 1, '作废后确实起了一次进程', String(probeMod.stats.spawns));
  ok(probeMod.stats.stale >= 1, '统计里记了一次 stale');

  // 写回是「临时文件 → 改名」，且只写有效元数据
  probeMod.clear();
  probeMod.openDisk(path.join(tmp, 'write-test.json'));
  probeMod.flushNow();
  ok(fs.existsSync(path.join(tmp, 'write-test.json')) === false, '没有新数据时不写盘');

  // forget：从磁盘缓存里摘掉一条（--selftest 造的 __selftest__.mp3 靠它清理，别留在用户缓存里）
  probeMod.clear();
  fs.writeFileSync(cacheFile, JSON.stringify({
    v: 1,
    files: { [f]: { size: st.size, mtimeMs: st.mtimeMs, meta: { ok: true, duration: 7 } } },
  }), 'utf8');
  probeMod.openDisk(cacheFile);
  eq(probeMod.diskSize(), 1, 'forget 前磁盘缓存里有 1 条');
  probeMod.forget(f);
  eq(probeMod.diskSize(), 0, 'forget 后该条从磁盘缓存里消失');
  probeMod.openDisk(null);   // 关掉磁盘缓存，别影响后面的用例
})();

console.log('\n== 列表显示名（未探测元数据时） ==');
{
  eq(P.displayName('05. 老歌5'), '老歌5', '去掉前导编号');
  eq(P.displayName('歌名 - 歌手 - 专辑'), '歌名', '「歌名 - 歌手 - 专辑」只留歌名');
  eq(P.displayName('歌名-歌手'), '歌名', '没有空格的连字符也切');
  eq(P.displayName('示例歌曲'), '示例歌曲', '本来就只有歌名 → 原样返回');
  eq(P.displayName(''), '', '空名不炸');
  eq(P.songLabel({ base: 'x - y' }), 'x', '还没探测元数据 → 用清洗后的文件名');
  eq(P.songLabel({ base: 'z', meta: { title: '标题' } }), '标题', '有 title → 优先 title');
}

console.log('\n== 搜索输入框 ==');
{
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const savedIn = P.state.inputMode;
  const savedF = P.state.filter;
  const savedV = P.state.view;

  P.state.inputMode = true;
  P.state.filter = '';
  P.state.view = [{}, {}, {}];
  let l = P.renderHelp(60);
  eq(U.width(plain(l)), 59, '空输入时提示条宽 = cols-1（59）');
  ok(plain(l).includes('搜索'), '有「搜索」标签');
  ok(plain(l).includes('▏'), '空输入也有光标 ▏');
  ok(plain(l).includes('Enter 确认'), '保留按键说明');

  P.state.filter = '晴天';
  P.state.view = [{}, {}];
  l = P.renderHelp(60);
  ok(plain(l).includes('晴天'), '输入的内容显示在提示条上（不再只藏在顶部小字里）');
  ok(plain(l).includes('2 首'), '显示实时匹配数量');
  eq(U.width(plain(l)), 59, '有输入时宽度仍是 59');


  // 确认搜索后（已退出输入模式），条件与数量也要在底部提示条最前面
  P.state.inputMode = false;
  P.state.filter = '我的';
  P.state.view = [{}, {}, {}];
  const l2 = P.renderHelp(100);
  ok(plain(l2).includes('搜索「我的」'), '确认后底部仍显示搜索条件（不再只靠顶部小字）');
  ok(plain(l2).includes('3 首'), '并且带匹配数量');
  eq(U.width(plain(l2)), 99, '有搜索时提示条宽度仍是 99');
  P.state.filter = '很长很长的关键字一二三四五六七八九十';
  l = P.renderHelp(40);
  eq(U.width(plain(l)), 39, '40 列窄屏也正好 39，不超宽');

  P.state.inputMode = savedIn;
  P.state.filter = savedF;
  P.state.view = savedV;
}
console.log('\n== 记忆播放进度 ==');
{
  const view = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  eq(P.resumeTarget(view, { path: 'b', position: 42 }, 0).index, 1, '回到上次那首（下标 1）');
  eq(P.resumeTarget(view, { path: 'b', position: 42 }, 0).pos, 42, '从上次的位置 42s 接上');
  eq(P.resumeTarget(view, { path: 'b', position: 42 }, 0).found, true, '标记找到了');
  eq(P.resumeTarget(view, { path: 'zzz', position: 42 }, 0).index, 0, '歌不在了 → 回到第一首');
  eq(P.resumeTarget(view, { path: 'zzz', position: 42 }, 0).found, false, '歌不在就不续播');
  eq(P.resumeTarget(view, { path: 'c', position: 42 }, 15).pos, 15, '--start 优先于上次进度');
  eq(P.resumeTarget(view, { path: 'a', position: 2 }, 0).pos, 0, '开头 3 秒内不续播（当作从头）');
  eq(P.resumeTarget(view, null, 0).index, 0, '没有记录 → 第一首');
  eq(P.resumeTarget([], { path: 'a', position: 9 }, 0).index, 0, '空视图不炸');

  // playStateRecord：只算要写什么，不碰磁盘
  const b = makeStub();
  P.setBackend(b);
  const song = { path: 'X:/a.mp3', meta: { duration: 200 } };
  const savedPlaying = P.state.playing;
  P.state.playing = song;
  b.file = song.path; b.duration = 200; b.position = 42.6; b.volume = 65; b.speed = 1.5;
  const rec = P.playStateRecord();
  eq(rec.last.path, song.path, '记住是哪一首');
  eq(rec.last.position, 43, '记住当前进度（四舍五入到秒）');
  eq(rec.volume, 65, '记住音量');
  eq(rec.speed, 1.5, '记住倍速');
  ok(rec.viewMode === P.state.viewMode, '记住当前视图（歌词/列表）');

  // 分类也要记住：退出时在哪个文件夹，下次进来还是那个
  eq(P.playStateRecord().dirFilter, null, '没选分类时记 null（= 全部）');
  P.state.dirFilter = '示例分类';
  eq(P.playStateRecord().dirFilter, '示例分类', '记住当前分类');
  P.state.dirFilter = null;

  b.position = 1.2;
  eq(P.playStateRecord().last.position, 0, '开头 3 秒内记成 0');
  b.position = 197;
  eq(P.playStateRecord().last.position, 0, '结尾 5 秒内记成 0（下次从头听）');
  b.position = 88; b.file = 'X:/other.mp3';
  // 后端还没载入这首时不许动 last：否则启动瞬间退出会把上次进度抹成 0
  eq(P.playStateRecord().last, undefined, '后端载入的不是这首 → 不碰上次记录');
  eq(P.playStateRecord().volume, 65, '但音量倍速照旧记');
  P.state.playing = savedPlaying;

  eq(P.savePlayState(true), false, 'persist 关闭时 savePlayState 不写盘');
}
console.log('\n== 进度条 ==');
{
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  // 进度条：总宽应等于请求宽度，已播部分随比例增长
  const b0 = P.progressBar(0, 100, 20);
  const b50 = P.progressBar(50, 100, 20);
  const b100 = P.progressBar(100, 100, 20);
  eq(U.width(strip(b0)), 20, '进度条 0% 宽度 = 20');
  eq(U.width(strip(b50)), 20, '进度条 50% 宽度 = 20');
  eq(U.width(strip(b100)), 20, '进度条 100% 宽度 = 20');
  ok(U.width(strip(b50)) === U.width(strip(b0)), '进度条宽度不随进度抖动');
  ok(/\x1b\[38;5;44m/.test(b50), '已播部分有实心块颜色');
  ok(/\x1b\[38;5;236m/.test(b50), '未播部分是暗色');
}

console.log('\n== 歌词高亮（只高亮当前句） ==');
{
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const stub = makeStub();
  stub.position = 6;   // 落在第二行歌词（5.5s 起）
  P.setBackend(stub);
  P.state.playing = P.state.songs[0];
  P.state.lrc = { lines: [
    { t: 1, text: '第一句歌词' },
    { t: 5.5, text: '第二句歌词' },
    { t: 9, text: '第三句歌词' },
  ] };
  P.state.viewMode = 'lyrics';
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  P.setFullRedraw(true);
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { P.render(); } finally { process.stdout.write = orig; }
  const frame = chunks.join('');
  const lineOf = (txt) => frame.split('\r\n').find((l) => strip(l).includes(txt)) || '';

  ok(/\x1b\[38;5;195m/.test(lineOf('第二句歌词')), '当前句用亮青 195 高亮');
  ok(!/\x1b\[38;5;241m/.test(lineOf('第二句歌词')), '当前句不是暗淡色');
  ok(/\x1b\[38;5;241m/.test(lineOf('第一句歌词')), '上一句是暗淡色');
  ok(/\x1b\[38;5;241m/.test(lineOf('第三句歌词')), '下一句也是暗淡色（不再提前高亮）');
  ok(!/\x1b\[38;5;250m/.test(lineOf('第三句歌词')), '下一句没有"提前浅色"');
  ok(!/\x1b\[38;5;226m/.test(frame), '没有黄色逐字高亮残留');
}

console.log('\n== 渲染宽度 ==');
{
  const stub = makeStub();
  P.setBackend(stub);
  P.state.playing = P.state.songs[0];
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  P.setFullRedraw(true);
  const frame = (cols, rows, mode) => {
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    P.state.viewMode = mode;
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try { P.render(); } finally { process.stdout.write = orig; }
    return chunks.join('').split('\r\n');
  };

  for (const cols of [100, 80, 60, 40]) {
    for (const mode of ['lyrics', 'list']) {
      const lines = frame(cols, 24, mode);
      const over = lines.filter((l) => U.width(strip(l)) > cols);
      ok(over.length === 0, `${cols} 列 ${mode} 视图无超宽行`,
        over.length ? `超宽 ${U.width(strip(over[0]))}` : '');
      ok(lines.length === 24, `${cols} 列 ${mode} 视图正好 24 行`, `${lines.length} 行`);
      const last = strip(lines[lines.length - 1]);
      ok(last.includes('空格'), `${cols} 列 ${mode} 提示行贴底`, `最后一行: ${last.trim().slice(0, 20)}`);
      ok(last.includes('m ') && last.includes(P.helpItems().find((it) => it[0] === 'm')[1]),
        `${cols} 列 ${mode} 提示条显示当前播放模式`, `最后一行: ${last.trim().slice(-20)}`);
    }
  }

  // 渲染层通过 live() 拿"当前" backend：换掉对象后必须立刻生效，不能留旧引用
  const bNew = { volume: 12, speed: 0.5, state: 'paused', file: 'X:/a.mp3', duration: 200, position: 88 };
  P.setBackend(bNew);
  const pl = P.progressLine(120, 88, 200);
  ok(pl.includes('vol 12'), '换掉 backend 后渲染用的是新对象（live 同步）', pl.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 90));
  ok(pl.includes('0.5x'), '倍速也跟着新 backend', pl.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 90));
  P.setBackend(stub);

  // --rendertest / --selftest 靠 ctx 传依赖，少一个字段只会让自检崩，平时看不出来
  const needCtx = ['state', 'opts', 'lrcDirs', 'backend', 'FFPROBE', 'rescan', 'watchDirs', 'cleanup', 'loadLyricsFor', 'render', 'setFullRedraw'];
  const missingCtx = needCtx.filter((k) => !(k in P.selftestCtx()));
  ok(missingCtx.length === 0, 'selftestCtx 字段齐全', missingCtx.join(','));

  // 提示行高亮 + 倍速可见
  const help = frame(100, 24, 'lyrics').pop();
  ok(/\x1b\[38;5;117m/.test(help) && /\x1b\[1m/.test(help), '提示行按键名亮青加粗');
  ok(/\x1b\[48;5;236m/.test(help), '提示行整行深灰底（状态条）');
  ok(/\x1b\[38;5;250m/.test(help), '提示行说明文字是浅灰');
  ok(strip(frame(80, 24, 'lyrics').pop()).includes('q 退出'), '80 列下仍显示 q 退出');
  for (const cols of [100, 80, 60, 40]) {
    const prog = frame(cols, 24, 'lyrics').find((l) => strip(l).includes('%')) || '';
    ok(/\b1x\b/.test(strip(prog)), `${cols} 列进度行显示倍速 1x`, strip(prog).trim().slice(-24));
  }

  // 列表视图也要有进度条，而且要在列表上方，不能被遮住
  for (const cols of [100, 80, 60, 40]) {
    const plain = frame(cols, 24, 'list').map(strip);
    const progIdx = plain.findIndex((l) => l.includes('%') && /\d+x/.test(l));
    ok(progIdx >= 0, `${cols} 列列表视图保留了进度条`);
    const firstListRow = plain.findIndex((l) => /^\s+▶?\s*\d+\s{2}/.test(l) || l.includes('│'));
    ok(firstListRow < 0 || progIdx < firstListRow, `${cols} 列进度条在列表上方，没被遮挡`,
      `进度第 ${progIdx + 1} 行，列表第 ${firstListRow + 1} 行`);
  }
}

console.log('\n== 差分重绘 ==');
{
  Object.defineProperty(process.stdout, 'columns', { value: 84, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  P.setFullRedraw(false);
  P.resetFrame();
  const capture = (fn) => {
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try { fn(); } finally { process.stdout.write = orig; }
    return chunks.join('');
  };
  const f1 = capture(() => P.render());
  const f2 = capture(() => P.render());
  ok(f1.length > 500, '首帧写入了完整画面', `首帧 ${f1.length} 字节`);
  ok(f2.length < f1.length / 3, '第二帧只写变化的行', `第二帧 ${f2.length} 字节（首帧 ${f1.length}）`);
  ok(/\x1b\[\d+;1H/.test(f1 === f2 ? '' : f2) || f2.length === 0, '差分帧用光标定位而不是整屏重画');
  P.setFullRedraw(true);
}


console.log('\n== 渲染宽度：84 列 ==');
{
  const COLS = 84;

  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  P.setFullRedraw(true);   // 差分输出只写变化的行，测试要整帧
  for (const mode of ['lyrics', 'list']) {
    P.state.viewMode = mode;
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try { P.render(); } finally { process.stdout.write = orig; }
    const lines = chunks.join('').split('\r\n');
    const over = lines.filter((l) => U.width(strip(l)) > COLS);
    ok(over.length === 0, `${mode} 视图无超宽行（宽度 ${COLS}）`, over.length ? `第一行超宽 ${U.width(strip(over[0]))}` : '');
    ok(lines.length <= 24, `${mode} 视图不超过终端高度`, `${lines.length} 行`);
  }
}

// 异步块（磁盘缓存要等 Promise）跑完再汇总
(asyncChecks || Promise.resolve()).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n== 歌词索引增量重建 ==');
  {
    const tmpLrc = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-lrc-inc-'));
    const mk = (n, b) => fs.writeFileSync(path.join(tmpLrc, n), b, 'utf8');
    mk('a.lrc', '[00:00.00]A\n');
    mk('b.lrc', '[00:00.00]B\n');
    mk('c.lrc', '[00:00.00]C\n');

    lyrics.clearIndexCache();
    let idx = lyrics.buildIndex([tmpLrc]);
    let st = lyrics.buildStats();
    eq(idx.length, 3, '首次建索引得到 3 个');
    eq(st.parsed, 3, '首次全部要解析');
    eq(st.reused, 0, '首次没有可复用的');

    idx = lyrics.buildIndex([tmpLrc]);
    st = lyrics.buildStats();
    eq(idx.length, 3, '再跑一次还是 3 个');
    eq(st.parsed, 0, '没改动 → 零解析（本次优化的核心）');
    eq(st.reused, 3, '没改动 → 全部复用');

    // 改一个：必须让 mtime 明确变化，否则按设计会当成没改
    const t0 = Date.now();
    while (Date.now() - t0 < 25) { /* 等 mtime 跨过一个时间片 */ }
    mk('b.lrc', '[00:00.00]B改过\n[00:05.00]第二行\n');
    idx = lyrics.buildIndex([tmpLrc]);
    st = lyrics.buildStats();
    eq(st.parsed, 1, '改 1 个 → 只解析那 1 个');
    eq(st.reused, 2, '其余 2 个照旧复用');
    const changed = idx.find((i) => i.stem === 'b');
    eq(changed && changed.lineCount, 2, '改后的内容真的生效了');

    // 删一个：索引和缓存都要跟着减
    fs.unlinkSync(path.join(tmpLrc, 'c.lrc'));
    idx = lyrics.buildIndex([tmpLrc]);
    eq(idx.length, 2, '删掉一个后索引剩 2 个');
    st = lyrics.buildStats();
    eq(st.files, 2, '已删的文件不再出现在统计里');
    eq(st.reused, 2, '剩下的全部复用');

    // force：绕过缓存
    idx = lyrics.buildIndex([tmpLrc], { force: true });
    st = lyrics.buildStats();
    eq(st.parsed, 2, 'force → 全部重新解析');
    eq(st.reused, 0, 'force → 一个都不复用');

    fs.rmSync(tmpLrc, { recursive: true, force: true });
    lyrics.clearIndexCache();
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
});
