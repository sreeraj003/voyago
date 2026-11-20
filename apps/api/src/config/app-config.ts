import { type Env } from './env.schema.js';

/** Injection token for the validated, read-only environment. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = Readonly<Env>;
