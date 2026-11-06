/**
 * The video upload must carry an explicit Cloudinary timeout.
 *
 * The SDK defaults to 60 seconds (lib/uploader.js: `post_request.setTimeout(
 * options.timeout != null ? options.timeout : 60000)`), which is fine for an avatar and
 * far too short for a video off a phone. A 24.8MB clip picked on a real device failed
 * with `Error: Request Timeout` - and failed badly: the bytes DID arrive, so Cloudinary
 * kept a 24.8MB asset while the handler had already given up, writing no database row and
 * destroying nothing.
 *
 * `multer-storage-cloudinary` copies every key of `params` other than `public_id` straight
 * into the options it hands `upload_stream`, so a `timeout` here does reach the uploader.
 * That also means a rename or a tidy-up could drop it without anything failing loudly -
 * hence this test.
 */

const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'config', 'cloudinary.js');

describe('cloudinary upload timeout', () => {
  let storage;
  let thumbnailStorage;

  beforeAll(() => {
    jest.resetModules();
    ({ storage, thumbnailStorage } = require(CONFIG));
  });

  it('gives the video storage a timeout well above the 60s default', () => {
    expect(storage.params.timeout).toBeGreaterThan(60000);
  });

  it('allows a slow phone uplink to finish a large upload', () => {
    // Enough headroom that the route's own size ceiling, not the clock, is what stops an
    // upload. 5 minutes is the floor asserted; the configured value is 10.
    expect(storage.params.timeout).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('still bounds the request rather than waiting forever', () => {
    // A stuck upload must not hold a connection open indefinitely.
    expect(storage.params.timeout).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('keeps the video folder and resource type it is uploading to', () => {
    // The timeout is passed alongside these, in the same params object that the storage
    // adapter forwards wholesale - so if these survive, so does it.
    expect(storage.params.folder).toBe('yteens_videos');
    expect(storage.params.resource_type).toBe('video');
  });

  it('leaves the thumbnail storage on the default', () => {
    // Deliberate: a thumbnail is a couple of megabytes and the 60s default covers it.
    // Asserted so that raising it later is a decision rather than a copy-paste.
    expect(thumbnailStorage.params.timeout).toBeUndefined();
  });
});
