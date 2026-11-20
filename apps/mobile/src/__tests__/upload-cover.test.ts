import { uploadCover } from '../api/maps-media';

jest.mock('../api/http', () => ({
  apiRequest: jest.fn(() =>
    Promise.resolve({
      uploadUrl: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      fields: { api_key: '123', timestamp: '1', public_id: 'p', signature: 'sig' },
      imageId: 'voyago-dev/trip-covers/u/i',
      maxBytes: 8 * 1024 * 1024,
    }),
  ),
}));

describe('uploadCover', () => {
  it('posts the signed fields and file straight to Cloudinary', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve({ ok: true } as Response));
    const id = await uploadCover({ uri: 'file:///cover.jpg', mimeType: 'image/jpeg' }, fetchImpl);
    expect(id).toBe('voyago-dev/trip-covers/u/i');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    const body = init.body as FormData;
    expect(body.get('signature')).toBe('sig');
    expect(body.get('api_key')).toBe('123');
  });

  it('refuses images over the size limit before uploading', async () => {
    const fetchImpl = jest.fn();
    await expect(
      uploadCover({ uri: 'file:///big.jpg', fileSize: 20 * 1024 * 1024 }, fetchImpl),
    ).rejects.toThrow('under 8 MB');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a failed upload', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve({ ok: false } as Response));
    await expect(uploadCover({ uri: 'file:///c.jpg' }, fetchImpl)).rejects.toThrow(
      'could not be uploaded',
    );
  });
});
