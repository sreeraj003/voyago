import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createApp } from './bootstrap.js';
import { EnvValidationError, validateEnv } from './config/env.schema.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');

  let config;
  try {
    config = validateEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = await createApp(config);
  await app.listen(config.PORT);
}

await main();
