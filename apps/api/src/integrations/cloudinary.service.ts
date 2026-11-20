import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type UploadKind, type UploadSignature } from '@voyago/shared';
import { createHash, randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch, PROVIDER_TIMEOUT_MS } from './http-fetch.js';

export const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_FORMATS = 'jpg,jpeg,png,webp';
const FOLDERS: Record<UploadKind, string> = {
  'trip-cover': 'trip-covers',
  'community-cover': 'community-covers',
  'post-photo': 'post-photos',
  'chat-photo': 'chat-photos',
};
/**
 * Chat photos are private: uploaded as Cloudinary "authenticated" assets, which are served only
 * through URLs signed by this server, and those URLs are given only to the chat's members.
 */
const deliveryType = (kind: UploadKind) => (kind === 'chat-photo' ? 'authenticated' : 'upload');
const CHAT_PHOTO_TRANSFORM = 'c_limit,w_1600,q_auto,f_auto';

/**
 * Cloudinary for trip cover images. The app uploads straight to Cloudinary with a signature
 * from this service (the secret never leaves the server); the trip stores only the public id.
 * Delivered images are resized and re-encoded, which also drops embedded metadata such as GPS.
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: HttpFetch,
  ) {}

  get enabled(): boolean {
    return this.config.CLOUDINARY_API_SECRET.length > 0;
  }

  /** The folder a member's uploads of one kind must live in; other people's are rejected. */
  folderFor(userId: string, kind: UploadKind): string {
    return `${this.config.CLOUDINARY_FOLDER}/${FOLDERS[kind]}/${userId}`;
  }

  coverFolder(userId: string): string {
    return this.folderFor(userId, 'trip-cover');
  }

  signCoverUpload(userId: string, now = Date.now()): UploadSignature {
    return this.signUpload(userId, 'trip-cover', now);
  }

  signUpload(userId: string, kind: UploadKind, now = Date.now()): UploadSignature {
    this.assertEnabled();
    const imageId = `${this.folderFor(userId, kind)}/${randomUUID()}`;
    const params: Record<string, string> = {
      allowed_formats: COVER_FORMATS,
      public_id: imageId,
      timestamp: String(Math.floor(now / 1000)),
    };
    if (deliveryType(kind) === 'authenticated') params.type = 'authenticated';
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.CLOUDINARY_CLOUD_NAME}/image/upload`,
      fields: { ...params, api_key: this.config.CLOUDINARY_API_KEY, signature: this.sign(params) },
      imageId,
      maxBytes: COVER_MAX_BYTES,
    };
  }

  /** Cloudinary signature: sorted `key=value` pairs joined by `&`, then the secret, SHA-1. */
  sign(params: Record<string, string>): string {
    const payload = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
    return createHash('sha1')
      .update(payload + this.config.CLOUDINARY_API_SECRET)
      .digest('hex');
  }

  /**
   * Accepts a cover id only if it is in the member's own folder and the upload really exists
   * and is within the size limit (checked with the Admin API).
   */
  async assertOwnUploadedCover(userId: string, imageId: string): Promise<void> {
    return this.assertOwnUpload(userId, imageId, 'trip-cover', 'coverImageId');
  }

  async assertOwnUpload(
    userId: string,
    imageId: string,
    kind: UploadKind,
    path: string,
  ): Promise<void> {
    this.assertEnabled();
    const invalid = new BadRequestException({
      message: 'Validation failed',
      details: [{ path, message: 'Upload the image again' }],
    });
    if (!imageId.startsWith(`${this.folderFor(userId, kind)}/`)) throw invalid;
    const {
      CLOUDINARY_CLOUD_NAME: cloud,
      CLOUDINARY_API_KEY: key,
      CLOUDINARY_API_SECRET: secret,
    } = this.config;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.cloudinary.com/v1_1/${cloud}/resources/image/${deliveryType(kind)}/${imageId}`,
        {
          headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logger.warn(`Cloudinary check failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Image uploads are temporarily unavailable');
    }
    if (res.status === 404) throw invalid;
    if (!res.ok) {
      this.logger.warn(`Cloudinary responded ${res.status}`);
      throw new ServiceUnavailableException('Image uploads are temporarily unavailable');
    }
    const { bytes } = (await res.json()) as { bytes?: number };
    if (typeof bytes === 'number' && bytes > COVER_MAX_BYTES) throw invalid;
  }

  /** 1200×630 crop, automatic format and quality. Null when Cloudinary isn't configured. */
  coverUrl(imageId: string | null): string | null {
    if (!imageId || !this.config.CLOUDINARY_CLOUD_NAME) return null;
    return `https://res.cloudinary.com/${this.config.CLOUDINARY_CLOUD_NAME}/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_auto/${imageId}`;
  }

  /** Photos keep their shape, at most 1600 px wide. */
  photoUrl(imageId: string): string | null {
    if (!this.config.CLOUDINARY_CLOUD_NAME) return null;
    return `https://res.cloudinary.com/${this.config.CLOUDINARY_CLOUD_NAME}/image/upload/c_limit,w_1600,q_auto,f_auto/${imageId}`;
  }

  /** A signed link to a private chat photo. Null when Cloudinary isn't configured. */
  chatPhotoUrl(imageId: string): string | null {
    if (!this.enabled || !this.config.CLOUDINARY_CLOUD_NAME) return null;
    const toSign = `${CHAT_PHOTO_TRANSFORM}/${imageId}`;
    const signature = createHash('sha1')
      .update(toSign + this.config.CLOUDINARY_API_SECRET)
      .digest('base64url')
      .slice(0, 8);
    return `https://res.cloudinary.com/${this.config.CLOUDINARY_CLOUD_NAME}/image/authenticated/s--${signature}--/${toSign}`;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException('Image uploads are not available yet');
  }
}
