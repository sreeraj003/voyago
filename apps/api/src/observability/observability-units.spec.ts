import { MetricsRegistry, percentile } from './metrics.registry.js';
import { scrub } from './scrub.js';
import { indiaDay } from './analytics.service.js';

describe('scrub', () => {
  it('removes contact details, ids, tokens, coordinates and query strings', () => {
    const out = scrub(
      'Failed for asha@example.com at 12.971599,77.594566 calling /trips?q=goa&lat=12.9 ' +
        'user 123e4567-e89b-12d3-a456-426614174000 phone +91 98450 00002 token ' +
        'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(out).not.toMatch(/asha|example\.com/);
    expect(out).not.toMatch(/12\.971599|77\.594566/);
    expect(out).not.toContain('q=goa');
    expect(out).not.toContain('123e4567');
    expect(out).not.toContain('98450');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('[email]');
    expect(out).toContain('[id]');
  });

  it('leaves ordinary error text alone', () => {
    expect(scrub("TypeError: Cannot read properties of undefined (reading 'map')")).toBe(
      "TypeError: Cannot read properties of undefined (reading 'map')",
    );
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });
});

describe('MetricsRegistry', () => {
  it('renders counters, gauges and latency histograms in Prometheus text', () => {
    const metrics = new MetricsRegistry();
    metrics.inc('jobs_total', { job: 'a "b"' }, 2, 'Jobs');
    metrics.set('dependency_up', { name: 'redis' }, 1);
    metrics.observeHttp('GET', '/api/v1/trips/:id', 200, 0.03);
    metrics.observeHttp('GET', '/api/v1/trips/:id', 500, 0.3);
    const text = metrics.render();
    expect(text).toContain('# HELP jobs_total Jobs');
    expect(text).toContain('jobs_total{job="a \\"b\\""} 2');
    expect(text).toContain('dependency_up{name="redis"} 1');
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*le="0\.05".*\} 1/);
    const summary = metrics.httpSummary();
    expect(summary.requests).toBe(2);
    expect(summary.serverErrors).toBe(1);
  });
});

describe('indiaDay', () => {
  it('uses the India date, not UTC', () => {
    expect(indiaDay(new Date('2026-11-23T19:00:00Z'))).toBe('2026-11-24');
    expect(indiaDay(new Date('2026-11-23T18:00:00Z'))).toBe('2026-11-23');
  });
});
