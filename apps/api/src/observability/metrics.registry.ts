import { Injectable } from '@nestjs/common';

/** Latency buckets in seconds, Prometheus-style. */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Recent samples kept per route for percentiles on the status page. */
const SAMPLES = 500;

type Labels = Record<string, string>;
type Histogram = { buckets: number[]; sum: number; count: number; samples: number[] };

const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Process metrics in memory, exposed in Prometheus text format at /metrics. Labels are route
 * patterns, methods, statuses and job names only: never ids, paths with values, or user data.
 */
@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly http = new Map<string, Histogram>();
  private readonly help = new Map<string, string>();

  inc(name: string, labels: Labels = {}, by = 1, help?: string) {
    if (help) this.help.set(name, help);
    const series = this.counters.get(name) ?? new Map<string, number>();
    const k = key(labels);
    series.set(k, (series.get(k) ?? 0) + by);
    this.counters.set(name, series);
  }

  set(name: string, labels: Labels, value: number, help?: string) {
    if (help) this.help.set(name, help);
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(key(labels), value);
    this.gauges.set(name, series);
  }

  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(key(labels)) ?? 0;
  }

  /** Sum of a counter over every label set matching `filter`. */
  total(name: string, filter: (labels: string) => boolean = () => true): number {
    let sum = 0;
    for (const [k, v] of this.counters.get(name) ?? []) if (filter(k)) sum += v;
    return sum;
  }

  observeHttp(method: string, route: string, status: number, seconds: number) {
    const labels = { method, route };
    this.inc('http_requests_total', { ...labels, status: String(status) }, 1, 'HTTP requests');
    const k = key(labels);
    const h = this.http.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0, samples: [] };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
    h.samples.push(seconds * 1000);
    if (h.samples.length > SAMPLES) h.samples.shift();
    this.http.set(k, h);
  }

  /** Latency per route from recent samples, slowest p95 first. */
  httpSummary() {
    const all: number[] = [];
    const routes = [...this.http.entries()].map(([k, h]) => {
      all.push(...h.samples);
      return {
        route: k.replace(/method="([^"]*)",route="([^"]*)"/, '$1 $2'),
        count: h.count,
        p95Ms: percentile(h.samples, 95),
      };
    });
    routes.sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
    return {
      requests: this.total('http_requests_total'),
      serverErrors: this.total('http_requests_total', (l) => /status="5\d\d"/.test(l)),
      p50Ms: percentile(all, 50),
      p95Ms: percentile(all, 95),
      slowest: routes.slice(0, 8),
    };
  }

  render(): string {
    const lines: string[] = [];
    const head = (name: string, type: string) => {
      lines.push(`# HELP ${name} ${this.help.get(name) ?? name}`, `# TYPE ${name} ${type}`);
    };
    for (const [name, series] of this.counters) {
      head(name, 'counter');
      for (const [k, v] of series) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, series] of this.gauges) {
      head(name, 'gauge');
      for (const [k, v] of series) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    if (this.http.size > 0) {
      head('http_request_duration_seconds', 'histogram');
      for (const [k, h] of this.http) {
        BUCKETS.forEach((b, i) =>
          lines.push(`http_request_duration_seconds_bucket{${k},le="${b}"} ${h.buckets[i]}`),
        );
        lines.push(`http_request_duration_seconds_bucket{${k},le="+Inf"} ${h.count}`);
        lines.push(`http_request_duration_seconds_sum{${k}} ${h.sum}`);
        lines.push(`http_request_duration_seconds_count{${k}} ${h.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
