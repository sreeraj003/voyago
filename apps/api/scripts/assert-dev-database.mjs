// Guard for destructive dev-only database commands (reset). Exits non-zero unless the
// target is a local database and NODE_ENV is not production.
import 'dotenv/config';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing: NODE_ENV is production.');
  process.exit(1);
}
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
  console.error(`Refusing: "${host}" is not a local database.`);
  process.exit(1);
}
