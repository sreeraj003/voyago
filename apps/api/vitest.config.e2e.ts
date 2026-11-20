import { defineConfig } from 'vitest/config';

// End-to-end tests boot the real app against the Docker Postgres/PostGIS and Redis
// services (see infra/docker). They never mock the database.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
