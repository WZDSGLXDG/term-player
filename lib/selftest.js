'use strict';
// 两个非交互自检：--rendertest（只画一帧查超宽）、--selftest（扫描 / 元数据 / 歌词 / 后端 / 文件监视）
const path = require('path');
const fs = require('fs');
const U = require('./ui');
const probe = require('./probe');
const lyrics = require('./lyrics');

// ---------------- 渲染自检：不交互，打印一帧并检查是否超宽 ----------------
async function rendertest(ctx) {
  const { state, opts, backend, FFPROBE, rescan, loadLyricsFor, render, setFullRedraw, cleanup } = ctx;
  setFullRedraw(true);   // 自检要整帧，差分输出没法按行解析
  const COLS = parseInt(process.env.TP_COLS, 10) || 100;
  const ROWS = parseInt(process.env.TP_ROWS, 10) || 30;
  Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });

  rescan(false);
  // 优先挑一首真有歌词的，好把逐字高亮渲染出来看
  let pick = state.songs.find((x) => lyrics.match(x, state.lyricsIndex));
  if (!pick) pick = state.songs[0];
  const lookahead = [pick, ...state.songs.slice(0, 4)].filter(Boolean);
  for (const s of lookahead) s.meta = await probe.probe(FFPROBE, s.path);
  if (pick) {
    state.playing = pick;
    loadLyricsFor(pick);
    // 伪造播放进度：停在当前歌词行的中间，展示"半句已唱"
    const l0 = state.lrc && state.lrc.lines[1];
    const fakePos = l0 ? l0.t + 0.5 : (pick.meta && pick.meta.duration ? pick.meta.duration * 0.4 : 8);
    backend.file = pick.path;
    backend.duration = (pick.meta && pick.meta.duration) || 0;
    backend.state = 'playing';
    // 两种后端的时钟字段都设一遍：FfplayBackend 用 _basePos/_startedAt，MpvBackend 用 _pos/_posAt
    backend._basePos = fakePos;
    backend._startedAt = Date.now();
    backend._pos = fakePos;
    backend._posAt = Date.now();
    backend._pausedPos = fakePos;
    // 选中项紧跟在正在播放那首之后：一屏里同时能看到「▶ 播放行（带歌手）」和「选中行（反显）」
    const pickIdx = state.songs.indexOf(pick);
    state.sel = pickIdx >= 0
      ? Math.min(pickIdx + 1, state.songs.length - 1)
      : Math.min(1, state.songs.length - 1);
  }

  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const capture = () => {
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try { render(); } finally { process.stdout.write = orig; }
    return chunks.join('').split('\r\n');
  };
  for (const mode of ['lyrics', 'list']) {
    state.viewMode = mode;
    const lines = capture();
    let over = 0;
    const shown = [];
    for (const raw of lines) {
      const plain = strip(raw);
      const w = U.width(plain);
      if (w > COLS) { over++; shown.push(plain + `   ← 超宽 ${w}>${COLS}`); }
      else shown.push(plain);
    }
    console.log(`\n===== ${mode} 视图（${COLS}x${ROWS}）=====`);
    for (const l of shown) console.log(l);
    console.log(`---- ${mode}: ${lines.length} 行，超宽 ${over} 行 ----`);
  }
  cleanup();
  process.exit(0);
}

// ---------------- 自检（不开 TUI） ----------------
async function selftest(ctx) {
  const { state, opts, lrcDirs, backend, FFPROBE, rescan, watchDirs, cleanup } = ctx;
  const t0 = Date.now();
  console.log('== 扫描 ==');
  rescan(false);
  console.log(`目录: ${opts.dir}`);
  console.log(`歌曲: ${state.songs.length} 首`);
  console.log(`递归: ${opts.recursive}`);
  console.log('');
  console.log('== 歌词目录 ==');
  for (const d of lrcDirs) console.log('  ' + d);
  console.log(`索引歌词: ${state.lyricsIndex.length} 个`);
  console.log('');

  console.log('== 元数据 + 歌词匹配 ==');
  const sample = state.songs.slice(0, 8);
  for (const s of sample) {
    const m = await probe.probe(FFPROBE, s.path);
    s.meta = m;
    const hit = lyrics.match(s, state.lyricsIndex);
    console.log(
      `  ${s.name}\n` +
      `     ${m.ok ? `${m.codec} ${m.sampleRate}Hz ${m.channels}ch ${U.fmtTime(m.duration)}` : 'probe 失败'}` +
      `  歌词: ${hit ? `命中(score=${hit.score}) ${path.basename(hit.file)}` : '无'}`
    );
    if (hit) {
      const first3 = hit.parsed.lines.slice(0, 3).map((l) => `${l.t.toFixed(2)}s ${l.text}`);
      for (const l of first3) console.log(`       ${l}`);
    }
  }

  if (sample.length) {
    console.log('');
    console.log('== 播放后端 ==');
    const first = sample[0];
    const dur = (first.meta && first.meta.duration) || 0;
    const startAt = dur > 20 ? 5 : 0;
    const seekTo = dur > 10 ? dur * 0.6 : dur * 0.5;
    backend.setVolume(5);
    await backend.load(first.path, dur, startAt);
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`  后端=${state.backendName}  从 ${startAt}s 播放 1.5s 后: state=${backend.state} pos=${backend.position.toFixed(2)}s`);
    backend.seek(seekTo, { commit: true });
    await new Promise((r) => setTimeout(r, 1200));
    const verdict = Math.abs(backend.position - seekTo) < 2.5 ? 'OK' : '偏差过大';
    console.log(`  seek 到 ${seekTo.toFixed(1)}s 后: pos=${backend.position.toFixed(2)}s  ${verdict}（含播放推进则正常）`);
    backend.pause();
    const p1 = backend.position;
    await new Promise((r) => setTimeout(r, 800));
    console.log(`  暂停后 0.8s 漂移: ${(backend.position - p1).toFixed(3)}s (state=${backend.state})`);
    backend.resume();
    await new Promise((r) => setTimeout(r, 800));
    console.log(`  恢复后: state=${backend.state} pos=${backend.position.toFixed(2)}s`);
    if (typeof backend.setSpeed === 'function') {
      const t0 = backend.position;
      const v = backend.setSpeed(2);
      await new Promise((r) => setTimeout(r, 1000));
      const advanced = backend.position - t0;
      console.log(`  倍速 ${v}x 跑 1s: 位置前进 ${advanced.toFixed(2)}s（1x 时应约 1.0s）`);
      console.log(`  倍速支持: OK`);
      backend.setSpeed(1);
    } else {
      console.log(`  倍速支持: 无（${state.backendName} 后端不支持）`);
    }
    // 「启动暂停」：窗口打开时载入但不 auto-play，按空格才出声
    const pausedFrom = dur > 30 ? 20 : Math.max(0, dur * 0.3);
    await backend.load(first.path, dur, pausedFrom, { paused: true });
    await new Promise((r) => setTimeout(r, 900));
    const frozen = backend.position;
    const pausedOk = backend.state === 'paused' && Math.abs(frozen - pausedFrom) < 2;
    console.log(`  暂停载入: state=${backend.state} pos=${frozen.toFixed(2)}s  结果: ${pausedOk ? 'OK 停住不出声' : '未停住'}`);
    backend.stop();
  }
  console.log('');
  // 文件监视：真实地增删一个文件，看库能否自动刷新
  console.log('');
  console.log('== 文件监视 ==');
  const testFile = path.join(opts.dir, '__selftest__.mp3');
  try {
    watchDirs();
    await new Promise((r) => setTimeout(r, 300));
    const before = state.songs.length;
    fs.copyFileSync(state.songs[0].path, testFile);
    await new Promise((r) => setTimeout(r, 1600));
    const afterAdd = state.songs.length;
    fs.unlinkSync(testFile);
    await new Promise((r) => setTimeout(r, 1600));
    const afterDel = state.songs.length;
    console.log(`  增删前 ${before} → 新增后 ${afterAdd} → 删除后 ${afterDel}`);
    console.log(`  结果: ${afterAdd === before + 1 && afterDel === before ? 'OK 自动刷新' : '未按预期刷新'}`);
  } catch (e) {
    console.log('  跳过（' + e.message + '）');
    try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile); } catch {}
  }
  // 自检自己造的临时文件不该留在用户的 meta-cache.json 里：forget 后立刻落盘
  // （2 秒的 flush 定时器是 unref 的，process.exit 会把它掐掉，所以必须显式 flushNow）
  try { probe.forget(testFile); probe.flushNow(); } catch { /* 缓存不可写不影响自检结论 */ }
  console.log(`自检耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  cleanup();
  process.exit(0);
}

module.exports = { rendertest, selftest };
