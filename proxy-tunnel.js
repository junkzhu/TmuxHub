'use strict';
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

// This owns only SSH children that it spawned. The remote end owns and may
// release only the sshd child of its own connection; no port-based killing.
class ProxyTunnelManager {
  constructor({root = __dirname, spawn = childProcess.spawn, timers = globalThis,
    now = Date.now, heartbeatMs = 5000, timeoutMs = 45000, retryMs = 5000} = {}) {
    if (heartbeatMs <= 0 || timeoutMs < heartbeatMs * 3 || timeoutMs < 1000 || timeoutMs > 600000 || retryMs <= 0)
      throw new Error('Invalid proxy watchdog timing');
    this.spawn = spawn; this.timers = timers; this.now = now;
    this.heartbeatMs = heartbeatMs; this.timeoutMs = timeoutMs; this.retryMs = retryMs;
    this.entries = new Map(); this.closed = false;
    const source = fs.readFileSync(path.join(root, 'proxy-watchdog.py'));
    const encoded = source.toString('base64');
    this.remoteCommand = `exec python3 -u -c 'import base64;exec(base64.b64decode("${encoded}"))' ${timeoutMs / 1000}`;
  }

  ensure(host) {
    if (this.closed || this.entries.has(host)) return;
    const entry = {host, child: null, retry: null, heartbeat: null, stopped: false, buffer: '', pending: new Set(), lastAck: this.now()};
    this.entries.set(host, entry);
    this.start(entry);
  }

  start(entry) {
    if (this.closed || entry.stopped || entry.child) return;
    entry.lastAck = this.now(); entry.buffer = ''; entry.pending.clear();
    let child;
    try {
      child = this.spawn('ssh.exe', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3', entry.host, this.remoteCommand], {windowsHide: true});
    } catch (_) { this.retry(entry); return; }
    entry.child = child;
    const unref = timer => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };
    const beat = () => {
      if (entry.child !== child || entry.stopped) return;
      if (this.now() - entry.lastAck >= this.timeoutMs) {
        // Wait for close before retrying: no overlapping child SSH processes.
        child.kill(); return;
      }
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        const nonce = crypto.randomBytes(12).toString('hex');
        entry.pending.add(nonce);
        while (entry.pending.size > Math.ceil(this.timeoutMs / this.heartbeatMs) + 1)
          entry.pending.delete(entry.pending.values().next().value);
        try { child.stdin.write('PING ' + nonce + '\n'); } catch (_) { child.kill(); }
      }
    };
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      if (entry.child !== child) return;
      entry.buffer += data.toString();
      if (entry.buffer.length > 8192) { child.kill(); return; }
      let end;
      while ((end = entry.buffer.indexOf('\n')) >= 0) {
        const line = entry.buffer.slice(0, end).trim();
        entry.buffer = entry.buffer.slice(end + 1);
        const match = /^PONG ([0-9a-f]{24})$/.exec(line);
        if (match && entry.pending.delete(match[1])) entry.lastAck = this.now();
        else if (line === 'UNSAFE') { child.kill(); return; }
      }
    });
    child.stderr.resume();
    child.on('error', () => {});
    child.once('close', () => {
      if (entry.child !== child) return;
      this.timers.clearInterval(entry.heartbeat); entry.heartbeat = null; entry.child = null;
      if (!this.closed && !entry.stopped) this.retry(entry);
    });
    entry.heartbeat = unref(this.timers.setInterval(beat, this.heartbeatMs));
    beat();
  }

  retry(entry) {
    if (this.closed || entry.stopped || entry.retry || entry.child) return;
    entry.retry = this.timers.setTimeout(() => { entry.retry = null; this.start(entry); }, this.retryMs);
    if (entry.retry && typeof entry.retry.unref === 'function') entry.retry.unref();
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      if (entry.retry) this.timers.clearTimeout(entry.retry);
      if (entry.heartbeat) this.timers.clearInterval(entry.heartbeat);
      if (entry.child) {
        try { entry.child.stdin.end(); } catch (_) {}
        entry.child.kill();
      }
    }
    this.entries.clear();
  }
}
module.exports = ProxyTunnelManager;
