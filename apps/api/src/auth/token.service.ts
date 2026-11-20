import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type AuthTokens } from '@voyago/shared';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

const ISSUER = 'voyago-api';
const ACCESS_AUDIENCE = 'voyago-app';
const SIGNUP_AUDIENCE = 'voyago-signup';
const SIGNUP_TTL_SECONDS = 15 * 60;

export interface AccessClaims {
  userId: string;
  /** The session family: every rotation of one sign-in shares it, so in-flight tokens stay valid. */
  sessionFamilyId: string;
}

/** A verified identity that has no account yet (phone OTP or Google/Apple). */
export const SignupIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phone'), phone: z.string() }),
  z.object({
    kind: z.literal('social'),
    provider: z.enum(['GOOGLE', 'APPLE']),
    providerUserId: z.string(),
    /** Present only when the provider says the address is verified. */
    email: z.string().nullable(),
    name: z.string().nullable(),
  }),
]);
export type SignupIdentity = z.infer<typeof SignupIdentitySchema>;

/**
 * Issues short-lived HS256 access tokens and signup tokens. Refresh tokens are opaque random
 * strings handled by SessionService; they are never JWTs, so they can always be revoked.
 */
@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly signupKey: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    // Signup tokens use a different key so they can never be accepted as access tokens.
    this.signupKey = new TextEncoder().encode(`signup:${config.OTP_HMAC_SECRET}`);
  }

  get accessTokenTtlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  async signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sessionFamilyId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.accessKey);
  }

  /** Throws 401 for any invalid, expired or foreign token. */
  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessKey, {
        issuer: ISSUER,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new UnauthorizedException('Authentication required');
      }
      return { userId: payload.sub, sessionFamilyId: payload.sid };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new UnauthorizedException('Access token expired');
      }
      throw new UnauthorizedException('Authentication required');
    }
  }

  async buildTokens(claims: AccessClaims, refreshToken: string): Promise<AuthTokens> {
    return {
      accessToken: await this.signAccessToken(claims),
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      tokenType: 'Bearer',
    };
  }

  async signSignupToken(identity: SignupIdentity): Promise<string> {
    return new SignJWT({ identity })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(SIGNUP_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${SIGNUP_TTL_SECONDS}s`)
      .sign(this.signupKey);
  }

  async verifySignupToken(token: string): Promise<SignupIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.signupKey, {
        issuer: ISSUER,
        audience: SIGNUP_AUDIENCE,
        algorithms: ['HS256'],
      });
      return SignupIdentitySchema.parse(payload.identity);
    } catch {
      throw new UnauthorizedException('Sign-up session expired. Start again.');
    }
  }
}
