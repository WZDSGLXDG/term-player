'use strict';
// 播放后端：mpv / mpv.net（命名管道 JSON IPC）
//
// 为什么用它：ffplay 没有运行时控制能力，暂停/seek/音量/倍速都得杀进程重启，
// 每次 167ms 空档。mpv 走 --input-ipc-server 命名管道，所有操作实时生效、零空档：
//   暂停    set_property pause true
//   seek    seek <秒> absolute
//   倍速    set_property speed 2.0
//   音量    set_property volume 40
//   位置    由播放器自己报告（不是前端估算），比 ffplay 那套时钟推算准
//
// mpv.net 实测同样支持（它是 mpv v0.41 的 GUI 前端，带完整 libmpv）。
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { pathDirs, firstFile } = require('./toolsearch');

class MpvBackend {
  constructor(opts = {}) {
    this.exe = opts.exe;
    this.pipe = `\\\\.\\pipe\\term-player-${process.pid}-${Date.now() % 100000}`;
    // mpv 的音量上限是 130（ffplay 只有 100）；上下限都在这里定死，别和 setVolume 打架
    this.volume = opts.volume == null ? 80 : Math.max(0, Math.min(130, Math.round(opts.volume)));
    this.speed = 1;
    this.state = 'stopped'; // playing | paused | stopped
    this.file = null;
    this.duration = 0;
    this.onEnded = null;
    this.onError = null;
    this.onStateChange = null;

    this._child = null;
    this._sock = null;
    this._buf = '';
    this._loadGen = 0;          // load() 代际号，防止两次 load 互相踩
    this._onFileLoaded = null;
    this._reqId = 0;
    this._pending = new Map();
    this._pos = 0;
    this._posAt = 0;          // 收到 _pos 的时刻，用于插值
    this._pausedPos = 0;
    this._pollTimer = null;
    this._ready = null;
    this._alive = false;
    this._disposed = false;
  }

  // ---------- 启动与连接 ----------
  start() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await this._spawnOnce();
          return true;
        } catch (e) {
          lastErr = e;
          this._killChild();
          if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
        }
      }
      this._ready = null;   // 允许下次重新尝试
      throw lastErr || new Error('mpv 启动失败');
    })();
    return this._ready;
  }

  // 起一次 mpv 进程并连上 IPC；失败时抛出带诊断信息的错误
  async _spawnOnce() {
    // 上一轮可能留下还活着的旧进程/旧管道：先收干净再起新的，否则会变孤儿进程占着音频设备
    this._killChild();
    if (this._sock) { const old = this._sock; this._sock = null; try { old.destroy(); } catch { /* 已经关了 */ } }
    this._alive = false;
    this._buf = '';
    this._stderrBuf = '';
    this._exitInfo = '';
    this._failAll('重新连接 mpv');
    this._child = spawn(this.exe, [
      `--input-ipc-server=${this.pipe}`,
      '--no-video',
      '--no-terminal',
      '--idle=yes',
      '--force-window=no',
      // 必须强制立体声：库里有 12 声道且 channel_layout=unknown 的 ogg，
      // mpv 的 WASAPI 输出遇到这种布局会直接崩溃（0xC0000005），auto-safe 也拦不住。
      // 对普通 mp3/flac 无影响，多声道文件则降混到立体声。
      '--audio-channels=stereo',
      `--volume=${Math.round(this.volume)}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    // 收着 mpv 自己的报错，连不上时能说清原因（以前丢弃了，只能看到"未连接"）
    if (this._child.stderr) {
      this._child.stderr.setEncoding('utf8');
      this._child.stderr.on('data', (d) => {
        this._stderrBuf = (this._stderrBuf + d).slice(-2000);
      });
    }

    this._child.on('error', (e) => {
      this._exitInfo = 'spawn 失败: ' + e.message;
      if (this.onError) this.onError(e);
    });
    this._child.on('exit', (code, sig) => {
      this._alive = false;
      this._exitInfo = `mpv 进程退出 code=${code}${sig ? ' signal=' + sig : ''}`;
      this._failAll('mpv 进程已退出');
      if (this._onFileLoaded) this._onFileLoaded(new Error('mpv 进程已退出'));
      if (!this._disposed) {
        this.state = 'stopped';
        if (this.onStateChange) this.onStateChange('stopped');
      }
    });

    this._hideWindow();

    // 等管道就绪再连
    for (let i = 0; i < 50 && !this._disposed; i++) {
      await new Promise((r) => setTimeout(r, 120));
      if (this._child.exitCode !== null) break;   // 进程已经退了，再等也没用
      const ok = await this._tryConnect();
      if (ok) break;
    }
    if (!this._alive) throw new Error(this._diagnose('连不上 mpv 的 IPC 管道'));
    await this.send(['set_property', 'pause', true]).catch(() => {});
    this._startPolling();
  }

  _diagnose(what) {
    const parts = [what];
    if (this._exitInfo) parts.push(this._exitInfo);
    const err = (this._stderrBuf || '').trim();
    if (err) parts.push('mpv 报错: ' + err.split(/\r?\n/).slice(-3).join(' | '));
    parts.push('exe=' + this.exe);
    return parts.join('；');
  }

  _killChild() {
    if (this._child && this._child.exitCode === null) {
      const pid = this._child.pid;
      try { this._child.kill(); } catch {}
      try {
        require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true, timeout: 3000 });
      } catch { /* 已经退了 */ }
    }
    this._child = null;
    this._alive = false;
  }

  _tryConnect() {
    return new Promise((resolve) => {
      const s = net.connect(this.pipe);
      const onErr = () => { s.destroy(); resolve(false); };
      s.once('error', onErr);
      s.once('connect', () => {
        s.removeListener('error', onErr);
        s.setEncoding('utf8');
        this._sock = s;
        this._alive = true;
        this._buf = '';   // 旧连接残留的半行会把新连接的第一条消息弄坏
        s.on('data', (chunk) => { if (this._sock === s) this._onData(chunk); });
        s.on('error', (e) => {
          if (this._sock !== s) return;
          this._alive = false;
          this._failAll('mpv 管道断开: ' + e.message);   // 不然每条命令都要白等 3 秒超时
        });
        s.on('close', () => {
          if (this._sock !== s) return;   // 旧 socket 的 close 不能把新连接判死
          this._alive = false;
          this._failAll('mpv 管道已关闭');
        });
        resolve(true);
      });
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id && this._pending.has(msg.request_id)) {
        const { resolve } = this._pending.get(msg.request_id);
        this._pending.delete(msg.request_id);
        resolve(msg);
      } else if (msg.event) {
        this._onEvent(msg);
      }
    }
  }

  _onEvent(msg) {
    switch (msg.event) {
      case 'property-change':
        if (msg.name === 'time-pos' && typeof msg.data === 'number') {
          this._pos = msg.data;
          this._posAt = Date.now();
        } else if (msg.name === 'duration' && typeof msg.data === 'number') {
          this.duration = msg.data;
        }
        break;
      case 'file-loaded':
        if (this._onFileLoaded) this._onFileLoaded();
        this.send(['get_property', 'duration'])
          .then((r) => { if (typeof r.data === 'number' && r.data > 0) this.duration = r.data; })
          .catch(() => {});
        break;
      case 'end-file':
        if (msg.reason === 'eof') {
          this.state = 'stopped';
          this._pos = this.duration || this._pos;
          if (this.onStateChange) this.onStateChange('stopped');
          if (this.onEnded) this.onEnded();
        } else if (msg.reason === 'error') {
          const err = new Error('mpv 无法打开该文件');
          if (this._onFileLoaded) this._onFileLoaded(err);
          if (this.onError) this.onError(err);
        }
        break;
      default:
        break;
    }
  }

  _failAll(reason) {
    for (const [, p] of this._pending) p.reject(new Error(reason));
    this._pending.clear();
  }

  // 把 mpv.net 的窗口藏起来（纯 mpv.exe 没有窗口，直接跳过）
  _hideWindow() {
    if (!/mpvnet/i.test(this.exe || '')) return;
    if (!this._child || this._child.exitCode !== null) return;
    const path = require('path');
    const script = path.join(__dirname, 'hide-window.ps1');
    try {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, String(this._child.pid),
      ], { stdio: 'ignore', windowsHide: true });
      ps.on('error', () => {});
      if (ps.unref) ps.unref();
    } catch { /* 藏不掉也不影响播放 */ }
  }

  // ---------- 命令 ----------
  send(cmd) {
    if (!this._sock || !this._alive) return Promise.reject(new Error(this._diagnose('mpv 未连接')));
    return new Promise((resolve, reject) => {
      const id = ++this._reqId;
      this._pending.set(id, { resolve, reject });
      try {
        this._sock.write(JSON.stringify({ command: cmd, request_id: id }) + '\n');
      } catch (e) {
        this._pending.delete(id);
        return reject(e);
      }
      // unref：命令一直不回时别把进程退出拖住 3 秒（dispose 之后这些定时器还活着）
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('mpv 命令超时: ' + cmd.join(' ')));
        }
      }, 3000).unref();
    });
  }
  // loadfile 是异步的：mpv 还没读完文件时发 seek 会被丢掉，所以等 file-loaded 事件
  _waitFileLoaded(ms = 4000) {
    const gen = this._loadGen;
    let done = false;
    let timer = null;
    return new Promise((resolve, reject) => {
      const finish = (err) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (this._onFileLoaded === mine) this._onFileLoaded = null;
        if (err) reject(err); else resolve();
      };
      // 只有还属于当前这一代的 load 才认这个回调
      const mine = (err) => { if (gen === this._loadGen) finish(err); };
      // 这一代已经被新的 load 顶掉时安静收场（resolve），别拿「超时」去触发播放失败降级：
      // 快速连按两下 Enter，上一代残留的 4 秒超时会误判成 mpv 坏了，把正在播的歌切到 ffplay。
      timer = setTimeout(() => finish(gen === this._loadGen ? new Error('mpv 载入超时') : null), ms);
      this._onFileLoaded = mine;
    });
  }


  // time-pos 变化不够勤时用轮询兜底
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      if (!this._alive || this.state !== 'playing') return;
      if (Date.now() - this._posAt < 400) return; // 事件刚推过，不用问
      try {
        const r = await this.send(['get_property', 'time-pos']);
        if (typeof r.data === 'number') {
          this._pos = r.data;
          this._posAt = Date.now();
        }
      } catch { /* 下一轮再试 */ }
    }, 400);
  }

  // ---------- 对外接口（与 FfplayBackend 一致） ----------
  get position() {
    if (this.state === 'paused' || this.state === 'stopped') {
      return Math.min(this._pausedPos || this._pos, this.duration || Infinity);
    }
    // 两次事件之间做线性插值，进度条才平滑
    const extra = (Date.now() - this._posAt) / 1000 * (this.speed || 1);
    return Math.min(this._pos + Math.max(0, extra), this.duration || Infinity);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (this.onStateChange) this.onStateChange(s);
  }

  async load(file, duration, startSec = 0, { paused = false } = {}) {
    // 每次 load 领一个代际号：快速连按 Enter 时，旧的那次会自动让位，
    // 不会再把 seek 打到新文件上，也不会把新文件的状态改回 playing
    const gen = ++this._loadGen;
    // 上一次会话挂了（进程退出/管道断开）就重来一遍，不要让一次失败锁死整个播放器
    if (!this._alive || !this._sock) this._ready = null;
    await this.start();
    if (gen !== this._loadGen) return;
    this.file = file;
    this.duration = duration || 0;
    this._pos = startSec || 0;
    this._posAt = Date.now();
    this._pausedPos = startSec || 0;
    await this.send(['set_property', 'speed', this.speed]).catch(() => {});
    if (gen !== this._loadGen) return;
    // 先挂上 file-loaded 监听，再发 loadfile，否则事件可能在 seek 之后才到
    const loaded = this._waitFileLoaded(4000);
    try {
      const r = await this.send(['loadfile', file, 'replace']);
      if (r.error && r.error !== 'success') throw new Error('loadfile 失败: ' + r.error);
      if (gen !== this._loadGen) { loaded.catch(() => {}); return; }
      // 打不开的文件走 reject：别硬设成 playing，否则 mpv 其实在 idle，
      // UI 却显示在播、进度条自己往前跑，onEnded 永远不触发
      await loaded;
    } catch (e) {
      loaded.catch(() => {});   // 别留下未处理的 rejection
      throw e;
    }
    if (gen !== this._loadGen) return;
    // mpv 进程起来时本来就是暂停态，paused 只要不解除暂停、把位置摆好就行
    if (paused) {
      this._pausedPos = startSec || 0;
      this._pos = startSec || 0;
      this._posAt = Date.now();
      // 文件真正加载完再 seek，否则会被 mpv 丢掉
      if (startSec > 0.05) await this.send(['seek', startSec, 'absolute']).catch(() => {});
      this._setState('paused');
      this._hideWindow();
      return;
    }
    await this.send(['set_property', 'pause', false]).catch(() => {});
    // 文件真正加载完再 seek，否则会被 mpv 丢掉
    if (startSec > 0.05) await this.send(['seek', startSec, 'absolute']).catch(() => {});
    this._setState('playing');
    // 切歌时 mpv.net 可能重新显示窗口，再藏一次
    this._hideWindow();
  }

  pause() {
    if (this.state !== 'playing') return;
    this._pausedPos = this.position;
    this._pos = this._pausedPos;
    this._setState('paused');
    this.send(['set_property', 'pause', true]).catch(() => {});
  }

  resume() {
    if (this.state === 'playing' || !this.file) return;
    this._posAt = Date.now();
    this._setState('playing');
    this.send(['set_property', 'pause', false]).catch(() => {});
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.resume();
  }

  seek(sec, opts = {}) {
    if (!this.file) return;
    const target = Math.max(0, Math.min(sec, this.duration ? this.duration - 0.05 : sec));
    this._pos = target;
    this._posAt = Date.now();
    this._pausedPos = target;
    // mpv 的 seek 是异步的，但它会立刻回报新位置，不需要像 ffplay 那样重启
    this.send(['seek', target, 'absolute']).catch(() => {});
    if (this.onSeek) this.onSeek(target);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(130, Math.round(v)));
    this.send(['set_property', 'volume', this.volume]).catch(() => {});
  }

  setSpeed(v) {
    this.speed = Math.max(0.25, Math.min(4, Number(v) || 1));
    this.send(['set_property', 'speed', this.speed]).catch(() => {});
    // 倍速变了，插值系数跟着变
    this._pos = this.position;
    this._posAt = Date.now();
    return this.speed;
  }

  stop() {
    this.file = null;
    this._pos = 0;
    this._pausedPos = 0;
    this._setState('stopped');
    this.send(['stop']).catch(() => {});
  }

  dispose() {
    this._disposed = true;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._failAll('已释放');
    try { if (this._sock) this._sock.end(); } catch {}
    // Windows 上 child.kill() 是异步的，调用方紧接着 process.exit() 会把它抢掉，
    // 所以这里用同步 taskkill 兜底，确保不留后台 mpv 进程
    if (this._child && this._child.exitCode === null) {
      const pid = this._child.pid;
      try { this._child.kill(); } catch {}
      try {
        require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true, timeout: 4000 });
      } catch { /* 已经退了 */ }
    }
    this._alive = false;
  }
}

// 找一个可用的 mpv：显式路径 > PATH > 常见安装位置（mpv.exe 或 mpvnet.exe）
// 候选顺序 = 探测优先级，别随手调换（纯 mpv 优先于 mpv.net：无窗口、启动快）
function findMpv(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  for (const d of pathDirs()) cands.push(path.join(d, 'mpv.exe'), path.join(d, 'mpvnet.exe'));
  cands.push(
    'D:\\software\\mpv\\mpv.exe',
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\ffmpeg\\bin\\mpv.exe',
    'C:\\Program Files\\mpv.net\\mpvnet.exe',
    'D:\\software\\mpv.net\\mpvnet.exe',
    path.join(process.env.LOCALAPPDATA || '', 'mpv.net\\mpvnet.exe'),
  );
  return firstFile(cands);
}

module.exports = { MpvBackend, findMpv };
