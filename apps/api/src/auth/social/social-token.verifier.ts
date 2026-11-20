import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { type SocialProvider } from '@voyago/shared';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

export const SOCIAL_KEY_RESOLVERS = Symbol('SOCIAL_KEY_RESOLVERS');
export type SocialKeyResolvers = Record<SocialProvider, JWTVerifyGetKey>;

/** Provider public keys. Fetched lazily and cached by jose; nothing is fetched at startup. */
export function remoteKeyResolvers(): SocialKeyResolvers {
  return {
    google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
  };
}

const ISSUERS: Record<SocialProvider, string[]> = {
  google: ['https://accounts.google.com', 'accounts.google.com'],
  apple: ['https://appleid.apple.com'],
};

export interface SocialIdentity {
  provider: 'GOOGLE' | 'APPLE';
  providerUserId: string;
  /** Only set when the provider says the address is verified. */
  email: string | null;
  name: string | null;
}

/**
 * Verifies Google and Apple ID tokens obtained by the mobile app's native sign-in.
 * A provider is enabled only when its client ids are configured; otherwise sign-in returns 503.
 */
@Injectable()
export class SocialTokenVerifier {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SOCIAL_KEY_RESOLVERS) private readonly keys: SocialKeyResolvers,
  ) {}

  isEnabled(provider: SocialProvider): boolean {
    return this.audiences(provider).length > 0;
  }

  async verify(provider: SocialProvider, idToken: string): Promise<SocialIdentity> {
    if (!this.isEnabled(provider)) {
      throw new ServiceUnavailableException(
        `${provider === 'google' ? 'Google' : 'Apple'} sign-in is not available`,
      );
    }
    try {
      const { payload } = await jwtVerify(idToken, this.keys[provider], {
        issuer: ISSUERS[provider],
        audience: this.audiences(provider),
        algorithms: ['RS256', 'ES256'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('no sub');
      // Apple sends email_verified as the string "true".
      const verified = payload.email_verified === true || payload.email_verified === 'true';
      const email =
        verified && typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
      const name = typeof payload.name === 'string' ? payload.name.slice(0, 80) : null;
      return {
        provider: provider === 'google' ? 'GOOGLE' : 'APPLE',
        providerUserId: payload.sub,
        email,
        name,
      };
    } catch {
      throw new UnauthorizedException('Sign-in could not be verified');
    }
  }

  private audiences(provider: SocialProvider): string[] {
    return provider === 'google' ? this.config.GOOGLE_CLIENT_IDS : this.config.APPLE_CLIENT_IDS;
  }
}
