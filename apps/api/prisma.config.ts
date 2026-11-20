import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // `prisma generate` needs no database, so a missing URL must not block typecheck, lint or
  // unit tests (e.g. in CI). Commands that do connect (migrate, studio) fail with a clear error.
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
