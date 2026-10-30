'use strict';
// Runs on Windows; stdin/stdout carry bytes, and no TCP listener is opened.
const net = require('node:net');
const rawPort = process.argv[2] || '7890';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) process.exit(2);
const upstream = net.createConnection({host: '127.0.0.1', port: Number(rawPort)});
let ended = false;
function fail() {
  if (ended) return;
  ended = true;
  upstream.destroy();
  process.stdin.destroy();
  process.exitCode = 1;
}
upstream.on('error', fail);
process.stdin.on('error', fail);
process.stdout.on('error', fail);
upstream.on('close', () => { process.stdin.destroy(); });
process.stdin.pipe(upstream);
upstream.pipe(process.stdout);
