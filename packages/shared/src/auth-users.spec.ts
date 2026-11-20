import { describe, expect, it } from 'vitest';
import {
  EmailSchema,
  MotorcycleInputSchema,
  PhoneSchema,
  PublicProfileSchema,
  RegisterSchema,
  UpdatePreferencesSchema,
  UpdateProfileSchema,
  UsernameSchema,
} from './index.js';

describe('auth schemas', () => {
  it('normalises email and phone', () => {
    expect(EmailSchema.parse('  Rider@Example.COM ')).toBe('rider@example.com');
    expect(PhoneSchema.parse('+91 98765-43210')).toBe('+919876543210');
    expect(PhoneSchema.safeParse('9876543210').success).toBe(false);
  });

  it('validates usernames', () => {
    for (const ok of ['rider_01', 'a.b', 'Nandi.Hills']) {
      expect(UsernameSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['ab', '.lead', 'trail.', 'two..dots', 'has space', 'admin', 'Voyago']) {
      expect(UsernameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('requires a 10+ character password on registration', () => {
    const base = { email: 'a@b.co', username: 'rider', displayName: 'R' };
    expect(RegisterSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(RegisterSchema.safeParse({ ...base, password: 'long enough!' }).success).toBe(true);
  });
});

describe('profile schemas', () => {
  it('strips fields members must not set', () => {
    const parsed = UpdateProfileSchema.parse({ displayName: 'R', role: 'ADMIN', email: 'x@y.z' });
    expect(parsed).toEqual({ displayName: 'R' });
  });

  it('checks preference ranges when both ends are sent', () => {
    expect(
      UpdatePreferencesSchema.safeParse({ budgetMinPaise: 5, budgetMaxPaise: 1 }).success,
    ).toBe(false);
    expect(UpdatePreferencesSchema.safeParse({ groupSizeMin: 2, groupSizeMax: 6 }).success).toBe(
      true,
    );
    expect(UpdatePreferencesSchema.safeParse({}).success).toBe(false);
  });

  it('never accepts vehicle identifiers', () => {
    const parsed = MotorcycleInputSchema.parse({
      make: 'Honda',
      model: 'CB350',
      category: 'STREET',
      registrationNumber: 'KA01AB1234',
      vin: 'X',
    });
    expect(parsed).not.toHaveProperty('registrationNumber');
    expect(parsed).not.toHaveProperty('vin');
  });

  it('public profiles have no contact fields', () => {
    expect(PublicProfileSchema.shape).not.toHaveProperty('email');
    expect(PublicProfileSchema.shape).not.toHaveProperty('phone');
  });
});
