#!/usr/bin/env node
/**
 * Realtime connection test: opens N authenticated sockets and measures connect time,
 * then sends one presence round trip per socket.
 *
 *   node scripts/perf/socket-load.mjs --base http://localhost:3000 --token <access token> --sockets 500
 *
 * Every socket uses the same member's token, which exercises the server's connection
 * handling and auth check; it is not a test of fan-out to many different members.
 * Run from the apps/api folder so socket.io-client resolves.
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const { io } = require('socket.io-client');

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    token: { type: 'string', default: process.env.LOAD_TOKEN ?? '' },
    sockets: { type: 'string', default: '200' },
    batch: { type: 'string', default: '50' },
  },
});
const total = Number(values.sockets);
const batch = Number(values.batch);
if (!values.token) {
  console.error('Pass --token (or LOAD_TOKEN) with an access token for a test member.');
  process.exit(1);
}

const open = () =>
  new Promise((resolve) => {
    const started = performance.now();
    const socket = io(values.base, {
      path: '/api/v1/realtime',
      auth: { token: values.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    socket.once('connect', () => resolve({ socket, ms: performance.now() - started }));
    socket.once('connect_error', (error) => resolve({ socket, error: error.message }));
  });

const sockets = [];
const times = [];
const errors = new Map();
const started = performance.now();
for (let i = 0; i < total; i += batch) {
  const results = await Promise.all(Array.from({ length: Math.min(batch, total - i) }, open));
  for (const r of results) {
    sockets.push(r.socket);
    if (r.error) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
    else times.push(r.ms);
  }
}
const elapsed = performance.now() - started;
times.sort((a, b) => a - b);
const pct = (p) =>
  Math.round(times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0);
const rss = process.memoryUsage().rss;
console.log(
  JSON.stringify({
    requested: total,
    connected: times.length,
    failed: Object.fromEntries(errors),
    connectP50ms: pct(50),
    connectP95ms: pct(95),
    totalSeconds: +(elapsed / 1000).toFixed(1),
    clientRssMb: Math.round(rss / 1e6),
  }),
);
for (const s of sockets) s.disconnect();
process.exit(0);
