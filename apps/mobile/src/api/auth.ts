import {
  type AuthMethods,
  AuthMethodsSchema,
  AuthTokensSchema,
  type RegisterInput,
  SignInResultSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest, refreshSession, signOutLocally, storeTokens } from './http';

/** Restores the session at launch from the stored refresh token. */
export async function restoreSession(): Promise<void> {
  if (!(await refreshSession())) await signOutLocally();
}

export const getAuthMethods = (): Promise<AuthMethods> =>
  apiRequest('/auth/methods', { auth: false, schema: AuthMethodsSchema });

export async function register(input: RegisterInput): Promise<void> {
  await apiRequest('/auth/register', { method: 'POST', body: input, auth: false });
  // Registration never says whether the email existed, so sign in to finish.
  await signIn(input.email, input.password);
}

export async function signIn(email: string, password: string): Promise<void> {
  const tokens = await apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
    schema: AuthTokensSchema,
  });
  await storeTokens(tokens);
}

export const requestOtp = (phone: string) =>
  apiRequest('/auth/otp/request', {
    method: 'POST',
    body: { phone },
    auth: false,
    schema: z.object({ expiresIn: z.number() }),
  });

/** Signs in an existing member, or returns the signup token for a new one. */
export async function verifyOtp(phone: string, code: string) {
  const result = await apiRequest('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code },
    auth: false,
    schema: SignInResultSchema,
  });
  if (result.status === 'AUTHENTICATED') await storeTokens(result.tokens);
  return result;
}

/** Exchanges a Google or Apple ID token; signs in, or returns a signup token for a new member. */
export async function socialSignIn(provider: 'google' | 'apple', idToken: string) {
  const result = await apiRequest(`/auth/social/${provider}`, {
    method: 'POST',
    body: { idToken },
    auth: false,
    schema: SignInResultSchema,
  });
  if (result.status === 'AUTHENTICATED') await storeTokens(result.tokens);
  return result;
}

export async function completeSignup(input: {
  signupToken: string;
  username: string;
  displayName: string;
}): Promise<void> {
  const tokens = await apiRequest('/auth/signup/complete', {
    method: 'POST',
    body: input,
    auth: false,
    schema: AuthTokensSchema,
  });
  await storeTokens(tokens);
}

export const forgotPassword = (email: string) =>
  apiRequest('/auth/password/forgot', { method: 'POST', body: { email }, auth: false });

export const resetPassword = (token: string, password: string) =>
  apiRequest('/auth/password/reset', { method: 'POST', body: { token, password }, auth: false });

export const confirmEmail = (token: string) =>
  apiRequest('/auth/email/verify', { method: 'POST', body: { token }, auth: false });

export const requestEmailVerification = () =>
  apiRequest('/auth/email/verify/request', {
    method: 'POST',
    schema: z.object({ status: z.string() }),
  });

/** Revokes this device's session on the server, then forgets it locally either way. */
export async function signOut(): Promise<void> {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
  } finally {
    await signOutLocally();
  }
}
