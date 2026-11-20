// Integration check for DELETE /video/delete/:id and its Cloudinary cleanup.
//
// MongoDB is unreachable from this machine, so only the two Mongoose models are stubbed.
// Everything else is the real thing: the real router, the real middleware chain, a real
// HTTP request, and real Cloudinary assets that are really uploaded and really deleted.
//
//   node scripts/deleteRouteLiveCheck.js

require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const { cloudinary } = require('../config/cloudinary');

const VIDEO = path.join(__dirname, '..', 'test.mp4');
const VIDEO_ID = '0123456789abcdef01234567';
const CHANNEL_ID = 'fedcba98765432100fedcba9';

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); }
};

const exists = (publicId) =>
  cloudinary.api
    .resource(publicId, { resource_type: 'video' })
    .then(() => true)
    .catch((e) => (e.error && e.error.http_code === 404 ? false : 'error: ' + e.message));

// Replace a module in the require cache before the router pulls it in.
const stubModule = (relPath, exportsObj) => {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj
  };
};

(async () => {
  let videoAsset = null;
  let thumbAsset = null;

  try {
    console.log('[1] uploading two real Cloudinary assets (a video and a thumbnail)');
    videoAsset = await cloudinary.uploader.upload(VIDEO, {
      folder: 'yteens_videos', resource_type: 'video', format: 'mp4'
    });
    thumbAsset = await cloudinary.uploader.upload(VIDEO, {
      folder: 'yteens_videos', resource_type: 'video', format: 'mp4'
    });
    // The existing upload route stores the thumbnail URL with .mp4 rewritten to .jpg,
    // so the stored value is exercised exactly as it would be in the database.
    const storedThumbnailUrl = thumbAsset.secure_url.replace(/\.mp4$/, '.jpg');
    console.log(`    video     public_id: ${videoAsset.public_id}`);
    console.log(`    thumbnail public_id: ${thumbAsset.public_id}`);
    console.log(`    stored thumbnailUrl ends: ...${storedThumbnailUrl.slice(-30)}`);

    check('video exists before the delete', (await exists(videoAsset.public_id)) === true);
    check('thumbnail exists before the delete', (await exists(thumbAsset.public_id)) === true);

    console.log('\n[2] stubbing ONLY the Mongoose models');
    const calls = { findByIdAndDelete: [], channelSaved: 0 };

    const channelDoc = {
      _id: CHANNEL_ID,
      videos: [{ toString: () => VIDEO_ID }, { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' }],
      save: async () => { calls.channelSaved += 1; }
    };

    stubModule('../models/videoModel', {
      findById: async (id) =>
        id === VIDEO_ID
          ? { _id: VIDEO_ID, url: videoAsset.secure_url, thumbnailUrl: storedThumbnailUrl }
          : null,
      findByIdAndDelete: async (id) => { calls.findByIdAndDelete.push(id); return {}; }
    });
    stubModule('../models/channelModel', {
      findById: async (id) => (id === CHANNEL_ID ? channelDoc : null)
    });

    console.log('[3] mounting the REAL routes/videoRoute.js and making a real request');
    const app = express();
    app.use(express.json());
    app.use('/video', require('../routes/videoRoute'));
    const server = app.listen(0);
    const port = server.address().port;

    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ channelId: CHANNEL_ID });
      const req = http.request(
        { host: '127.0.0.1', port, path: `/video/delete/${VIDEO_ID}`, method: 'DELETE',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    server.close();

    console.log(`    HTTP ${response.status} ${response.body}`);

    console.log('\n[4] existing behaviour is unchanged');
    check('status is still 200', response.status === 200, String(response.status));
    check('message is unchanged', JSON.parse(response.body).msg === '✅ Video deleted and channel updated');
    check('the DB row was still deleted', calls.findByIdAndDelete[0] === VIDEO_ID);
    check('the channel was still saved', calls.channelSaved === 1);
    check('the video was removed from channel.videos', channelDoc.videos.length === 1);

    console.log('\n[5] the new part: Cloudinary is actually cleaned up');
    check('video asset is GONE from Cloudinary', (await exists(videoAsset.public_id)) === false);
    check('thumbnail asset is GONE from Cloudinary', (await exists(thumbAsset.public_id)) === false);
    if ((await exists(videoAsset.public_id)) === false) videoAsset = null;
    if ((await exists(thumbAsset.public_id)) === false) thumbAsset = null;

    console.log('\n[6] a video with no thumbnail still works');
    const soloAsset = await cloudinary.uploader.upload(VIDEO, {
      folder: 'yteens_videos', resource_type: 'video', format: 'mp4'
    });
    stubModule('../models/videoModel', {
      findById: async () => ({ _id: VIDEO_ID, url: soloAsset.secure_url, thumbnailUrl: '' }),
      findByIdAndDelete: async () => ({})
    });
    delete require.cache[require.resolve('../routes/videoRoute')];
    const app2 = express();
    app2.use(express.json());
    app2.use('/video', require('../routes/videoRoute'));
    const server2 = app2.listen(0);
    const port2 = server2.address().port;
    const r2 = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ channelId: CHANNEL_ID });
      const req = http.request(
        { host: '127.0.0.1', port: port2, path: `/video/delete/${VIDEO_ID}`, method: 'DELETE',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    server2.close();
    check('status 200 with no thumbnail', r2.status === 200, r2.body);
    check('solo video asset is GONE', (await exists(soloAsset.public_id)) === false);
    if ((await exists(soloAsset.public_id)) === false) { /* already gone */ } else {
      await cloudinary.uploader.destroy(soloAsset.public_id, { resource_type: 'video' });
    }
  } catch (err) {
    console.log(`\n  ERROR: ${err.stack}`);
    fail += 1;
  } finally {
    // Anything the test failed to delete must not be left behind.
    for (const asset of [videoAsset, thumbAsset]) {
      if (asset) {
        await cloudinary.uploader.destroy(asset.public_id, { resource_type: 'video' }).catch(() => {});
        console.log(`\n  cleanup: removed leftover ${asset.public_id}`);
      }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
