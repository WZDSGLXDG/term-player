'use strict';
// 播放后端：ffplay
//
// 为什么这么实现：Windows 上 WMP COM 与 WinRT MediaPlayer 在无消息泵的宿主里都起不来
// （WMP 恒为 playState=9，WinRT 恒为 PlaybackState=None、Position=0，实测三种格式全中），
// 所以用 ffplay 进程播放，位置由本地时钟推算：
//   position = 启动点位置 + (现在 - 启动时刻)
// 暂停 / seek / 改音量一律"杀掉进程再从新位置重启"，位置始终精确到 ±0.3s。
// 连续 seek 和连续调音量都做了合并，避免一次按键堆一个进程。
const { spawn } = require('child_process');

const STARTUP_LATENCY_MS = 120; // ffplay 启动到出声的粗略延迟，用来校准时钟

class FfplayBackend {
  constructor(opts = {}) {
    this.ffplay = opts.ffplay;
    // ffplay 的 -volume 上限就是 100；这里就钳好，别让「构造时 120、按一次 + 掉到 100」这种突降发生
    this.volume = opts.volume == null ? 80 : Math.max(0, Math.min(100, Math.round(opts.volume)));
    this.onEnded = null;
    this.onError = null;
    this.onStateChange = null;
    this.file = null;
    this.duration = 0;
    this.state = 'stopped'; // playing | paused | stopped
    this._child = null;
    this._basePos = 0;
    this._startedAt = 0;
    this._pausedPos = 0;
    this._killed = false;
    this._seekTimer = null;
    this._pendingSeek = null;
    this._volTimer = null;
    this._gen = 0; // 防止旧进程的 exit 事件把新播放判成结束
  }

  get position() {
    if (!this.file) return 0;
    if (this.state === 'paused' || this.state === 'stopped') {
      return Math.min(this._pausedPos, this.duration || Infinity);
    }
    const elapsed = Math.max(0, (Date.now() - this._startedAt) / 1000);
    return Math.min(this._basePos + elapsed, this.duration || Infinity);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (this.onStateChange) this.onStateChange(s);
  }

  _kill() {
    if (this._child) {
      this._killed = true;
      const c = this._child;
      this._child = null;
      try { c.kill(); } catch { /* 已经退了 */ }
    }
  }

  _spawnAt(sec) {
    this._kill();
    const gen = ++this._gen;
    const args = [
      '-hide_banner', '-loglevel', 'quiet', '-nodisp', '-autoexit',
      '-volume', String(Math.round(this.volume)),
      // 本地文件不需要长探测；缩短能减少每次 seek / 换曲 / 调音量的重启延迟
      '-probesize', '1000000', '-analyzeduration', '100000',
      '-ss', String(Math.max(0, sec).toFixed(3)),
      '-i', this.file,
    ];
    this._killed = false;
    this._basePos = Math.max(0, sec);
    this._startedAt = Date.now() + STARTUP_LATENCY_MS;
    const child = spawn(this.ffplay, args, { stdio: 'ignore', windowsHide: true });
    this._child = child;
    this._setState('playing');

    child.on('error', (err) => {
      if (gen !== this._gen) return;
      this._setState('stopped');
      if (this.onError) this.onError(err);
    });

    child.on('exit', () => {
      if (gen !== this._gen) return;
      if (this._child === child) this._child = null;
      if (this._killed) return; // 我们自己杀的，不算播完
      this._pausedPos = this.duration || this.position;
      this._setState('stopped');
      if (this.onEnded) this.onEnded();
    });
    return child;
  }

  load(file, duration, startSec = 0, { paused = false } = {}) {
    this._clearTimers();
    this.file = file;
    this.duration = duration || 0;
    this._pausedPos = Math.max(0, startSec);
    // paused：只记下位置，不启动进程。ffplay 没法"加载完停着"，
    // 停着就是不占用进程，等 resume() 再从这个位置起播
    if (paused) { this._setState('paused'); return; }
    this._spawnAt(this._pausedPos);
  }

  pause() {
    if (this.state !== 'playing') return;
    this._pausedPos = this.position;
    this._clearTimers();   // 挂着的 seek/音量重启定时器会跟 pause 抢进程
    this._kill();
    this._setState('paused');
  }

  resume() {
    if (this.state === 'playing') return;
    if (!this.file) return;
    this._clearTimers();   // 不清的话 180ms 后旧的 seek 定时器会把刚起的进程再杀一次
    this._spawnAt(this._pausedPos);
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.resume();
  }

  // 连续 seek 合并：180ms 内只真正重启一次
  seek(sec, { commit = false } = {}) {
    if (!this.file) return;
    const target = Math.max(0, Math.min(sec, this.duration ? this.duration - 0.05 : sec));
    this._pausedPos = target;
    this._basePos = target;
    this._startedAt = Date.now() + STARTUP_LATENCY_MS;
    this._pendingSeek = target;
    // 暂停时只记住位置，等 resume 时再起进程
    if (this.state === 'paused') return;
    if (commit) {
      this._clearSeekTimer();
      this._spawnAt(target);
      return;
    }
    if (this._seekTimer) return;
    this._seekTimer = setTimeout(() => {
      this._seekTimer = null;
      if (this._pendingSeek != null && this.state === 'playing') {
        const t = this._pendingSeek;
        this._pendingSeek = null;
        this._spawnAt(t);
      }
    }, 180);
  }

  _clearSeekTimer() {
    if (this._seekTimer) { clearTimeout(this._seekTimer); this._seekTimer = null; }
    this._pendingSeek = null;
  }

  _clearTimers() {
    this._clearSeekTimer();
    if (this._volTimer) { clearTimeout(this._volTimer); this._volTimer = null; }
  }

  // 音量：ffplay 只能启动时定音量，所以必须重启；连按合并成一次（220ms）
  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    if (this.state !== 'playing') return;
    if (this._volTimer) clearTimeout(this._volTimer);
    this._volTimer = setTimeout(() => {
      this._volTimer = null;
      if (this.state === 'playing') this._spawnAt(this.position);
    }, 220);
  }

  stop() {
    this._clearTimers();
    this._kill();
    this._pausedPos = 0;
    this._basePos = 0;
    this.file = null;
    this._setState('stopped');
  }

  dispose() {
    this._clearTimers();
    this._kill();
    this.file = null;
  }
}

module.exports = { FfplayBackend };
