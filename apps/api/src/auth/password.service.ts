import { hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB, 2 iterations, 1 lane).
 * The encoded hash stores its own parameters, so they can be raised later without breaking
 * existing passwords.
 */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** A real hash of a random string, verified when no user matches so timing does not reveal it. */
  private readonly dummyHash = hash(`dummy-${Math.random()}`, ARGON2_OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /** Always does the same work, whether or not `encoded` is present. */
  async verify(encoded: string | null | undefined, password: string): Promise<boolean> {
    if (!encoded) {
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  }
}
