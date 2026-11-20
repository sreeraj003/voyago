import { type ConfigContext, type ExpoConfig } from 'expo/config';

/**
 * Adds build-time settings from env on top of app.json, so no project ids or files are committed:
 * - EAS_PROJECT_ID: the Expo project (needed for push tokens; `eas init` prints it).
 * - GOOGLE_SERVICES_FILE: path to google-services.json from Firebase (Android push via FCM).
 * iOS push uses the APNs key uploaded to the Expo project with `eas credentials`.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  const googleServicesFile = process.env.GOOGLE_SERVICES_FILE?.trim();
  return {
    ...config,
    name: config.name ?? 'Voyago',
    slug: config.slug ?? 'voyago',
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
