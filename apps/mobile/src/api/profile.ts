import {
  type Preferences,
  PreferencesSchema,
  type PrivateProfile,
  PrivateProfileSchema,
  type UpdatePreferencesInput,
  type UpdateProfileInput,
} from '@voyago/shared';
import { apiRequest } from './http';

export const getMyProfile = (): Promise<PrivateProfile> =>
  apiRequest('/me', { schema: PrivateProfileSchema });

export const updateMyProfile = (input: UpdateProfileInput): Promise<PrivateProfile> =>
  apiRequest('/me', { method: 'PATCH', body: input, schema: PrivateProfileSchema });

export const getMyPreferences = (): Promise<Preferences> =>
  apiRequest('/me/preferences', { schema: PreferencesSchema });

export const updateMyPreferences = (input: UpdatePreferencesInput): Promise<Preferences> =>
  apiRequest('/me/preferences', { method: 'PATCH', body: input, schema: PreferencesSchema });
