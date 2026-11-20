// Live check of the moderation pipeline, independent of MongoDB.
//
// Uploads test.mp4 to Cloudinary exactly as the route's storage config would, answers the
// duration question from a real response, runs the pipeline against the real services,
// then always destroys the asset.
//
//   node scripts/pipelineLiveCheck.js            # text-rejection path, no ASR quota
//   node scripts/pipelineLiveCheck.js --accept   # full path: 1 ASR call + up to 30 image calls
//
// Never prints secrets.

require('dotenv').config({ quiet: true });
const path = require('path');
const { cloudinary } = require('../config/cloudinary');
const { moderateUpload } = require('../services/moderationPipeline');

const FULL = process.argv.includes('--accept');
// Defaults to the repo's test.mp4; a path argument overrides it, so a second clip can be
// checked without swapping files around.
const VIDEO_ARG = process.argv.slice(2).find((a) => !a.startsWith('--'));
const VIDEO = VIDEO_ARG || path.join(__dirname, '..', 'test.mp4');

// Clearly abusive, used only to confirm the text gate fires. Not aimed at anyone.
const BAD_TITLE = 'You are a worthless idiot and I will hurt you';
const GOOD_TITLE = 'A short clip from my holiday';

(async () => {
  let publicId = null;
  const started = Date.now();

  try {
    console.log(`[1] uploading ${path.basename(VIDEO)} to Cloudinary (same params as the route storage)`);
    const up = await cloudinary.uploader.upload(VIDEO, {
      folder: 'yteens_videos',
      resource_type: 'video',
      format: 'mp4'
    });
    publicId = up.public_id;
    console.log(`    uploaded: ${up.bytes} bytes, public_id captured`);

    console.log('\n[2] duration, from a real cloudinary.api.resource response');
    const info = await cloudinary.api.resource(publicId, { resource_type: 'video', media_metadata: true });
    console.log(`    duration      : ${info.duration}   (type ${typeof info.duration})`);
    console.log(`    width x height: ${info.width} x ${info.height}`);
    console.log(`    format, bytes : ${info.format}, ${info.bytes}`);
    const d = Number(info.duration);
    const unit =
      !Number.isFinite(d) ? 'MISSING - the pipeline cannot run'
        : d > 0 && d < 3600 ? 'SECONDS (plausible for a short clip)'
          : d >= 3600 ? 'suspicious - too large for a test clip, possibly milliseconds'
            : 'implausible';
    console.log(`    => unit       : ${unit}`);

    // Confirms the finding that multer does not hand the duration to the route.
    console.log('\n[3] what multer-storage-cloudinary would have given the handler');
    console.log('    path, size, filename only - duration is NOT among them,');
    console.log('    which is why step 2 is a required call rather than a fallback.');

    const videoUrl = up.secure_url;
    const title = FULL ? GOOD_TITLE : BAD_TITLE;

    console.log(`\n[4] running the pipeline with a ${FULL ? 'CLEAN' : 'DELIBERATELY ABUSIVE'} title`);
    if (!FULL) console.log('    expecting rejection at stage "text": 1 text call, no ASR, no image calls');

    const t0 = Date.now();
    const verdict = await moderateUpload({
      title,
      description: FULL ? 'Some ordinary footage.' : '',
      videoUrl,
      thumbnailUrl: null,
      videoId: publicId,
      durationSec: d
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`\n[5] verdict after ${elapsed}s`);
    console.log(`    accepted : ${verdict.accepted}`);
    if (!verdict.accepted) {
      console.log(`    stage    : ${verdict.stage}`);
      console.log(`    message  : ${verdict.message}`);
      if (verdict.detail) console.log(`    detail   : ${verdict.detail}`);
    } else {
      console.log(`    language : ${verdict.transcript.language}`);
      console.log(`    duration : ${verdict.transcript.durationSec}s (reported by the speech service)`);
      console.log(`    frames   : requested ${verdict.frames.requested}, returned ${verdict.frames.returned}`);
      console.log(`    transcript (${verdict.transcript.text.length} chars): ${verdict.transcript.text.slice(0, 200)}`);
      const ratio = d / verdict.transcript.durationSec;
      console.log(`    duration cross-check: Cloudinary ${d}s vs speech ${verdict.transcript.durationSec}s, ratio ${ratio.toFixed(3)}`);
    }
    console.log(`    stages   : ${JSON.stringify(Object.keys(verdict.log.stages))}`);
  } catch (err) {
    console.log(`\n    ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
        console.log('\n[6] cleanup: Cloudinary asset destroyed');
        const check = await cloudinary.api
          .resource(publicId, { resource_type: 'video' })
          .then(() => 'STILL PRESENT - cleanup failed')
          .catch((e) => (e.error && e.error.http_code === 404 ? 'confirmed gone (404)' : 'unknown: ' + e.message));
        console.log(`    verified: ${check}`);
      } catch (e) {
        console.log(`\n[6] cleanup FAILED: ${e.message}`);
      }
    }
    console.log(`\ntotal ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
})();
