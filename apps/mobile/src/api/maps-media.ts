import {
  type Features,
  FeaturesSchema,
  type Place,
  PlaceSchema,
  PlaceSuggestionSchema,
  type UploadKind,
  type UploadSignature,
  UploadSignatureSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

export const getFeatures = (): Promise<Features> =>
  apiRequest('/features', { schema: FeaturesSchema });

export const searchPlaces = (q: string, sessionToken: string) =>
  apiRequest(`/places/autocomplete?${new URLSearchParams({ q, sessionToken }).toString()}`, {
    schema: z.array(PlaceSuggestionSchema),
  });

export const getPlace = (placeId: string, sessionToken: string): Promise<Place> =>
  apiRequest(
    `/places/${encodeURIComponent(placeId)}?${new URLSearchParams({ sessionToken }).toString()}`,
    {
      schema: PlaceSchema,
    },
  );

export const getUploadSignature = (kind: UploadKind): Promise<UploadSignature> =>
  apiRequest('/uploads/signature', {
    method: 'POST',
    body: { kind },
    schema: UploadSignatureSchema,
  });

/** A new random token per search session (Google groups keystrokes + selection for billing). */
export function newSessionToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

type PickedImage = { uri: string; mimeType?: string | null; fileSize?: number | null };

/** A trip cover. */
export const uploadCover = (image: PickedImage, fetchImpl: typeof fetch = fetch) =>
  uploadImage(image, 'trip-cover', fetchImpl);

/**
 * Uploads a picked image straight to Cloudinary with a signature from the API, then returns
 * the image id to save (trip cover, community cover or post photo). The file never passes
 * through the Voyago API.
 */
export async function uploadImage(
  image: PickedImage,
  kind: UploadKind,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const signature = await getUploadSignature(kind);
  if (image.fileSize && image.fileSize > signature.maxBytes) {
    throw new Error(`Choose an image under ${Math.round(signature.maxBytes / 1024 / 1024)} MB`);
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(signature.fields)) form.append(key, value);
  const type = image.mimeType ?? 'image/jpeg';
  if (image.uri.startsWith('blob:') || image.uri.startsWith('data:')) {
    // Web: the picker returns a blob or data URL.
    form.append('file', await (await fetchImpl(image.uri)).blob());
  } else {
    // React Native's FormData accepts a file descriptor object.
    form.append('file', { uri: image.uri, name: 'cover', type } as unknown as Blob);
  }
  const res = await fetchImpl(signature.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error('The image could not be uploaded. Try a JPG, PNG or WebP photo.');
  return signature.imageId;
}
