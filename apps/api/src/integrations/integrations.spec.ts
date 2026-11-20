import { validateEnv } from '../config/env.schema.js';
import { CloudinaryService, COVER_MAX_BYTES } from './cloudinary.service.js';
import { GoogleMapsService } from './google-maps.service.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
};
const configured = validateEnv({
  ...base,
  GOOGLE_MAPS_API_KEY: 'test-maps-key',
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: '1234',
  CLOUDINARY_API_SECRET: 'abcd',
  CLOUDINARY_FOLDER: 'voyago-test',
});
const unconfigured = validateEnv(base);
const USER = '11111111-1111-4111-8111-111111111111';

type Call = { url: string; init: RequestInit };
const fakeFetch = (status: number, body: unknown, calls: Call[] = []) =>
  ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;

describe('env', () => {
  it('requires all three Cloudinary values together', () => {
    expect(() => validateEnv({ ...base, CLOUDINARY_CLOUD_NAME: 'demo' })).toThrow(/together/);
  });
});

describe('GoogleMapsService', () => {
  it('maps autocomplete suggestions and sends the key only in a header', async () => {
    const calls: Call[] = [];
    const maps = new GoogleMapsService(
      configured,
      fakeFetch(
        200,
        {
          suggestions: [
            {
              placePrediction: {
                placeId: 'ChIJabc123456',
                text: { text: 'Nandi Hills, Karnataka' },
                structuredFormat: {
                  mainText: { text: 'Nandi Hills' },
                  secondaryText: { text: 'Karnataka, India' },
                },
              },
            },
          ],
        },
        calls,
      ),
    );
    await expect(maps.autocomplete('nandi', 'session-12345')).resolves.toEqual([
      { placeId: 'ChIJabc123456', primaryText: 'Nandi Hills', secondaryText: 'Karnataka, India' },
    ]);
    expect(calls[0]?.url).not.toContain('test-maps-key');
    expect((calls[0]?.init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe(
      'test-maps-key',
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      includedRegionCodes: ['in'],
    });
  });

  it('returns place coordinates', async () => {
    const maps = new GoogleMapsService(
      configured,
      fakeFetch(200, {
        id: 'ChIJabc123456',
        displayName: { text: 'Nandi Hills' },
        formattedAddress: 'Nandi Hills, Karnataka 562103, India',
        location: { latitude: 13.3702, longitude: 77.6835 },
      }),
    );
    await expect(maps.placeDetails('ChIJabc123456', 'session-12345')).resolves.toEqual({
      placeId: 'ChIJabc123456',
      name: 'Nandi Hills',
      address: 'Nandi Hills, Karnataka 562103, India',
      point: { latitude: 13.3702, longitude: 77.6835 },
    });
  });

  it('computes a two-wheeler route for rides through the stops', async () => {
    const calls: Call[] = [];
    const maps = new GoogleMapsService(
      configured,
      fakeFetch(200, { routes: [{ distanceMeters: 61234, duration: '5400s' }] }, calls),
    );
    const points = [
      { latitude: 13.03, longitude: 77.59 },
      { latitude: 13.24, longitude: 77.71 },
      { latitude: 13.37, longitude: 77.68 },
    ];
    await expect(maps.computeRoute(points, 'RIDE')).resolves.toEqual({
      distanceMeters: 61234,
      durationSeconds: 5400,
      travelMode: 'TWO_WHEELER',
    });
    const body = JSON.parse(calls[0]?.init.body as string) as { intermediates: unknown[] };
    expect(body.intermediates).toHaveLength(1);
  });

  it('never fails a trip when routing is off or Google errors', async () => {
    const points = [
      { latitude: 1, longitude: 1 },
      { latitude: 2, longitude: 2 },
    ];
    await expect(
      new GoogleMapsService(unconfigured, fakeFetch(200, {})).computeRoute(points, 'RIDE'),
    ).resolves.toBeNull();
    await expect(
      new GoogleMapsService(configured, fakeFetch(500, {})).computeRoute(points, 'TRAVEL'),
    ).resolves.toBeNull();
    await expect(
      new GoogleMapsService(unconfigured, fakeFetch(200, {})).autocomplete('x', 'session-12345'),
    ).rejects.toThrow('not available');
  });
});

describe('CloudinaryService', () => {
  it('signs like Cloudinary documents it', () => {
    const cloudinary = new CloudinaryService(configured, fakeFetch(200, {}));
    // Example from Cloudinary's "Generating authentication signatures" guide (secret "abcd").
    expect(
      cloudinary.sign({
        eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
        public_id: 'sample_image',
        timestamp: '1315060510',
      }),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('issues a signature for the member folder without exposing the secret', () => {
    const cloudinary = new CloudinaryService(configured, fakeFetch(200, {}));
    const signed = cloudinary.signCoverUpload(USER, 1_800_000_000_000);
    expect(signed.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(signed.imageId).toMatch(new RegExp(`^voyago-test/trip-covers/${USER}/[0-9a-f-]{36}$`));
    expect(signed.fields).toMatchObject({
      api_key: '1234',
      timestamp: '1800000000',
      public_id: signed.imageId,
    });
    expect(JSON.stringify(signed)).not.toContain('abcd');
    expect(signed.maxBytes).toBe(COVER_MAX_BYTES);
  });

  it("rejects other members' images, missing uploads and oversized files", async () => {
    const own = `voyago-test/trip-covers/${USER}/22222222-2222-4222-8222-222222222222`;
    const other = `voyago-test/trip-covers/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222`;
    await expect(
      new CloudinaryService(configured, fakeFetch(200, { bytes: 1000 })).assertOwnUploadedCover(
        USER,
        own,
      ),
    ).resolves.toBeUndefined();
    await expect(
      new CloudinaryService(configured, fakeFetch(200, {})).assertOwnUploadedCover(USER, other),
    ).rejects.toThrow();
    await expect(
      new CloudinaryService(configured, fakeFetch(404, {})).assertOwnUploadedCover(USER, own),
    ).rejects.toThrow();
    await expect(
      new CloudinaryService(
        configured,
        fakeFetch(200, { bytes: COVER_MAX_BYTES + 1 }),
      ).assertOwnUploadedCover(USER, own),
    ).rejects.toThrow();
  });

  it('builds a resized delivery URL, or none when not configured', () => {
    const id = `voyago-test/trip-covers/${USER}/x`;
    expect(new CloudinaryService(configured, fakeFetch(200, {})).coverUrl(id)).toBe(
      `https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_auto/${id}`,
    );
    expect(new CloudinaryService(unconfigured, fakeFetch(200, {})).coverUrl(id)).toBeNull();
    expect(() =>
      new CloudinaryService(unconfigured, fakeFetch(200, {})).signCoverUpload(USER),
    ).toThrow('not available');
  });
});
