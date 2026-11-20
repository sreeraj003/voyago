import { EnvValidationError, validateEnv } from './env.schema.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
};

describe('validateEnv', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('parses comma-separated CORS origins', () => {
    const env = validateEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test ,' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails fast when the database URL is missing', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres database URL and a bad port', () => {
    try {
      validateEnv({ ...valid, DATABASE_URL: 'mysql://x', PORT: '70000' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.join(' ');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('PORT');
    }
  });

  it('requires auth secrets of at least 32 characters', () => {
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('refuses development-only adapters and placeholder secrets in production', () => {
    const production = { ...valid, NODE_ENV: 'production' };
    expect(() => validateEnv({ ...production, SMS_PROVIDER: 'dev' })).toThrow(/SMS_PROVIDER/);
    expect(() => validateEnv({ ...production, EMAIL_PROVIDER: 'dev' })).toThrow(/EMAIL_PROVIDER/);
    expect(() =>
      validateEnv({ ...production, JWT_ACCESS_SECRET: 'dev-only-change-me-0123456789abcdefghij' }),
    ).toThrow(/placeholder/);
    expect(() => validateEnv({ ...production, OTP_HMAC_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
      /must differ/,
    );
    expect(validateEnv(production).SMS_PROVIDER).toBe('none');
  });
});
