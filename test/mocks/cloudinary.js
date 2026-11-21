/**
 * Cloudinary stand-in for tests.
 *
 * Two things have to be faked, and the multer storage engine is the fiddly one:
 * config/cloudinary.js constructs CloudinaryStorage at REQUIRE time, so the mock has to
 * be registered before the route module loads. jest.mock is hoisted, which makes that
 * work — but it is also why a test that requires the route at the top of the file and
 * mocks afterwards fails in a way that looks like the mock being ignored.
 *
 * The storage engine writes a fake path/filename so multer completes without touching
 * the network, and uploader.destroy records its calls so a test can assert that a
 * rejected upload actually cleaned up its assets.
 */
const destroyed = [];
// Every file the fake storage engine accepted, so a test can assert that a doomed upload
// never reached Cloudinary at all. `failField` makes storing that field fail, to simulate a
// Cloudinary error after the first file was already stored.
const stored = [];
let failField = null;

const fakeStorage = {
  _handleFile(req, file, cb) {
    const isThumb = file.fieldname === 'thumbnail';
    const publicId = isThumb ? 'yteens_videos/test-thumb' : 'yteens_videos/test-video';
    if (failField && file.fieldname === failField) {
      file.stream.resume();
      return cb(new Error(`simulated Cloudinary failure on ${file.fieldname}`));
    }

    // The stream MUST be consumed before calling back.
    //
    // multer pipes the multipart body into the storage engine and does not move on
    // until this file's stream ends. A storage engine that calls cb() without draining
    // leaves the parser waiting for a stream nobody is reading, so the request never
    // completes and the test hangs with no output at all — which looks like an
    // infinite loop in the route rather than a mock that skipped a step.
    let size = 0;
    file.stream.on('data', (chunk) => { size += chunk.length; });
    file.stream.on('end', () => {
      stored.push(publicId);
      cb(null, {
        path: `https://res.cloudinary.com/demo/video/upload/${publicId}.mp4`,
        filename: publicId,
        size,
      });
    });
    file.stream.on('error', cb);
  },
  _removeFile(req, file, cb) {
    cb(null);
  },
};

const cloudinary = {
  api: {
    // media_metadata duration, which the route needs and multer-storage-cloudinary
    // does not return.
    resource: jest.fn(async () => ({
      duration: 42,
      width: 1280,
      height: 720,
      format: 'mp4',
      bytes: 1024,
    })),
  },
  uploader: {
    destroy: jest.fn(async (publicId, opts) => {
      destroyed.push({ publicId, opts });
      return { result: 'ok' };
    }),
  },
};

module.exports = {
  cloudinary,
  storage: fakeStorage,
  imageStorage: fakeStorage,
  thumbnailStorage: fakeStorage,
  /** Test helpers. */
  __destroyed: destroyed,
  __stored: stored,
  __failField(field) {
    failField = field;
  },
  __resetCloudinary() {
    destroyed.length = 0;
    stored.length = 0;
    failField = null;
    cloudinary.api.resource.mockClear();
    cloudinary.uploader.destroy.mockClear();
  },
};
