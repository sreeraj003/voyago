#!/usr/bin/env node
/**
 * HTTP load test for the API, with no extra dependencies (Node 22 fetch).
 *
 *   node scripts/perf/load-test.mjs --base http://localhost:3000 --token <access token> \
 *     --concurrency 20 --seconds 20
 *
 * Each endpoint is loaded on its own for --seconds with --concurrency workers. Prints
 * requests per second, p50/p95/p99 latency and any non-2xx answers. Point it at a
 * staging API with volume data (see seed-volume.sql), never at production.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    token: { type: 'string', default: process.env.LOAD_TOKEN ?? '' },
    concurrency: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '15' },
    trip: { type: 'string', default: '' },
    only: { type: 'string', default: '' },
  },
});
const base = values.base.replace(/\/$/, '');
const concurrency = Number(values.concurrency);
const seconds = Number(values.seconds);
if (!values.token) {
  console.error('Pass --token (or LOAD_TOKEN) with an access token for a test member.');
  process.exit(1);
}

// Random points around Bengaluru, so each request is a little different.
const jitter = () => ({
  lat: (12.97 + (Math.random() - 0.5) * 0.4).toFixed(4),
  lng: (77.59 + (Math.random() - 0.5) * 0.4).toFixed(4),
});
const DESTINATIONS = ['coorg', 'nandi', 'ooty', 'chikmagalur', 'mysuru', 'goa', 'hampi'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const endpoints = [
  { name: 'health/ready', path: () => '/api/v1/health/ready', auth: false },
  { name: 'me', path: () => '/api/v1/me' },
  {
    name: 'search (text)',
    path: () => `/api/v1/discovery/search?to=${pick(DESTINATIONS)}&limit=20`,
  },
  {
    name: 'search (near, by distance)',
    path: () => {
      const p = jitter();
      return `/api/v1/discovery/search?lat=${p.lat}&lng=${p.lng}&sort=proximity&limit=20`;
    },
  },
  {
    name: 'nearby 25 km',
    path: () => {
      const p = jitter();
      return `/api/v1/discovery/nearby?lat=${p.lat}&lng=${p.lng}&radiusKm=25&limit=20`;
    },
  },
  { name: 'trending', path: () => '/api/v1/discovery/trending?limit=20' },
  { name: 'feed', path: () => '/api/v1/feed?limit=20' },
];
if (values.trip)
  endpoints.push({ name: 'trip detail', path: () => `/api/v1/trips/${values.trip}` });

const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function load(endpoint) {
  const latencies = [];
  const failures = new Map();
  const deadline = Date.now() + seconds * 1000;
  const headers = endpoint.auth === false ? {} : { authorization: `Bearer ${values.token}` };
  const worker = async () => {
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        const res = await fetch(base + endpoint.path(), { headers });
        await res.arrayBuffer();
        latencies.push(performance.now() - started);
        if (!res.ok) failures.set(res.status, (failures.get(res.status) ?? 0) + 1);
      } catch (error) {
        const key = error instanceof Error ? error.message : 'error';
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  return {
    endpoint: endpoint.name,
    requests: latencies.length,
    rps: Math.round(latencies.length / seconds),
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    failures: Object.fromEntries(failures),
  };
}

const selected = values.only ? endpoints.filter((e) => e.name.includes(values.only)) : endpoints;
console.log(`Load: ${concurrency} concurrent, ${seconds}s per endpoint, against ${base}`);
const rows = [];
for (const endpoint of selected) {
  const row = await load(endpoint);
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.table(
  rows.map(({ failures, ...r }) => ({
    ...r,
    failed: Object.values(failures).reduce((a, b) => a + b, 0),
  })),
);
