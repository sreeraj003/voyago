import { z } from 'zod';
import { GeoPointSchema } from './geo.js';

/**
 * Google Maps place search and Cloudinary uploads. The apps never hold the provider secrets:
 * place searches go through the API, and uploads use a short-lived signature from the API.
 */

/** Groups one search's keystrokes and the final selection, as Google bills per session. */
const SessionToken = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const PlaceSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  sessionToken: SessionToken,
});

export const PlaceDetailsQuerySchema = z.object({ sessionToken: SessionToken });
export const PlaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,300}$/);

export const PlaceSuggestionSchema = z.object({
  placeId: z.string(),
  primaryText: z.string(),
  secondaryText: z.string().nullable(),
});
export type PlaceSuggestion = z.infer<typeof PlaceSuggestionSchema>;

export const PlaceSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  point: GeoPointSchema,
});
export type Place = z.infer<typeof PlaceSchema>;

/** Which optional integrations this server has configured. */
export const FeaturesSchema = z.object({
  placeSearch: z.boolean(),
  routing: z.boolean(),
  coverUploads: z.boolean(),
  /** Push notifications can be delivered (a push provider is configured on the server). */
  push: z.boolean(),
});
export type Features = z.infer<typeof FeaturesSchema>;

/** Everything the app needs to upload one image straight to Cloudinary. Valid for 1 hour. */
export const UploadSignatureSchema = z.object({
  uploadUrl: z.url(),
  /** Form fields to send with the file, exactly as given. */
  fields: z.record(z.string(), z.string()),
  /** The id to save on the trip once the upload succeeds. */
  imageId: z.string(),
  maxBytes: z.number().int(),
});
export type UploadSignature = z.infer<typeof UploadSignatureSchema>;

/** What an upload is for; each kind has its own folder. */
export const UploadKindSchema = z.enum([
  'trip-cover',
  'community-cover',
  'post-photo',
  'chat-photo',
]);
export type UploadKind = z.infer<typeof UploadKindSchema>;
export const UploadSignatureRequestSchema = z.object({ kind: UploadKindSchema });

const imageId = (folder: string) =>
  z
    .string()
    .regex(
      new RegExp(`^[a-z0-9_-]{1,40}/${folder}/[0-9a-f-]{36}/[0-9a-f-]{36}$`),
      'Upload the image again',
    );
export const CommunityCoverIdSchema = imageId('community-covers');
export const PostPhotoIdSchema = imageId('post-photos');
export const ChatPhotoIdSchema = imageId('chat-photos');

/** `<folder>/trip-covers/<user id>/<image uuid>`; the API also checks folder and owner. */
export const CoverImageIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}\/trip-covers\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/, 'Upload the image again');
