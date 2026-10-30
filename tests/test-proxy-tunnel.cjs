'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const ProxyTunnelManager = require('../proxy-tunnel.js');

let clock = 0, nextTimer = 0;
const scheduled = new Map();
const timers = {
  setInterval(fn, ms) { const id = ++nextTimer; scheduled.set(id, {fn, ms, at: clock + ms, repeat: true}); return id; },
  setTimeout(fn, ms) { const id = ++nextTimer; scheduled.set(id, {fn, ms, at: clock + ms, repeat: false}); return id; },
  clearInterval(id) { scheduled.delete(id); },
  clearTimeout(id) { scheduled.delete(id); },
};
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    const next = [...scheduled.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    const [id, timer] = next; clock = timer.at;
    if (timer.repeat) timer.at += timer.ms; else scheduled.delete(id);
    timer.fn();
  }
  clock = end;
}
class Stream extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.writableEnded = false; }
  write(s) { this.writes.push(s); }
  end() { this.writableEnded = true; }
  resume() {}
}
const children = [];
function spawn(program, args, options) {
  const c = new EventEmitter();
  Object.assign(c, {program, args, options, stdin: new Stream(), stdout: new Stream(), stderr: new Stream(), killed: 0, kill() { this.killed++; }});
  children.push(c); return c;
}
const mgr = new ProxyTunnelManager({root: path.resolve(__dirname, '..'), spawn, timers,
  now: () => clock, heartbeatMs: 1000, timeoutMs: 5000, retryMs: 2000});
mgr.ensure('cislab'); mgr.ensure('cislab');
assert.equal(children.length, 1, 'ensure must not create duplicates');
const first = children[0];
assert.equal(first.program, 'ssh.exe');
assert(first.args.includes('ExitOnForwardFailure=yes'));
assert(first.args.at(-1).startsWith('exec python3 -u -c '));
assert.equal(first.options.windowsHide, true);
let sent = first.stdin.writes.at(-1).trim().split(' ')[1];
assert.match(sent, /^[0-9a-f]{24}$/);
first.stdout.emit('data', Buffer.from('READY\nPONG invalid\nPONG ' + sent.slice(0, 8)));
assert.equal(mgr.entries.get('cislab').lastAck, 0, 'partial or unrelated ACK must not refresh liveness');
advance(1000);
first.stdout.emit('data', Buffer.from(sent.slice(8) + '\n'));
assert.equal(mgr.entries.get('cislab').lastAck, 1000, 'matching complete ACK refreshes liveness');
advance(5000);
assert(first.killed >= 1, 'missing heartbeats must stop only the manager child');
advance(5000);
assert.equal(children.length, 1, 'never spawn a replacement until prior child closes');
first.emit('close', 255);
advance(1999); assert.equal(children.length, 1);
advance(1); assert.equal(children.length, 2, 'retry after child closes');
const second = children[1];
first.stdout.emit('data', Buffer.from('PONG ' + sent + '\n'));
assert.equal(mgr.entries.get('cislab').child, second, 'stale output cannot affect replacement');
second.emit('close', 255); // e.g. occupied port: never touch unknown owner
advance(2000); assert.equal(children.length, 3, 'port occupied keeps retrying');
mgr.shutdown();
assert(children[2].stdin.writableEnded && children[2].killed, 'shutdown stops only owned child');
children[2].emit('close', 0);
advance(10000); assert.equal(children.length, 3, 'shutdown suppresses retry');
console.log('PASS: nonce ACK, partial records, duplicate prevention, timeout, closed-child retry, port contention, safe shutdown');
