/**
 * Find (and optionally delete) uploads that failed but stayed in Cloudinary.
 *
 *     node scripts/cleanupOrphanUploads.js             # dry run: list only
 *     node scripts/cleanupOrphanUploads.js --delete    # delete what the dry run listed
 *
 * Before middleware/uploadGuardMW.js, an upload rejected by sign-in checks (or one whose
 * server died mid-check) left its video and thumbnail in the `yteens_videos/` folder with
 * nothing in the database pointing at them. This lists every asset in that folder that:
 *   - no Video references (as `url` or `thumbnailUrl`), and
 *   - no queued/running UploadJob is still working on, and
 *   - is older than 1 hour (so an upload in progress right now is never touched).
 *
 * It uses the same MONGODB_URI / Cloudinary settings as the server (from .env), so run it
 * with the environment of the deployment you want to clean. Always look at the dry run
 * first: deleting is permanent.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const { cloudinary } = require('../config/cloudinary');
const { publicIdFromUrl } = require('../util/cloudinaryAsset');
const Video = require('../models/videoModel');
const UploadJob = require('../models/uploadJobModel');

const FOLDER = 'yteens_videos/';
const MIN_AGE_MS = 60 * 60 * 1000;

async function listFolder() {
  const out = [];
  let next_cursor;
  do {
    const page = await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'video',
      prefix: FOLDER,
      max_results: 500,
      next_cursor,
    });
    out.push(...(page.resources || []));
    next_cursor = page.next_cursor;
  } while (next_cursor);
  return out;
}

async function main() {
  const doDelete = process.argv.includes('--delete');
  await connectDB();

  const referenced = new Set();
  const videos = await Video.find({}, 'url thumbnailUrl').lean();
  for (const v of videos) {
    for (const u of [v.url, v.thumbnailUrl]) {
      const id = publicIdFromUrl(u);
      if (id) referenced.add(id);
    }
  }
  const active = await UploadJob.find(
    { status: { $in: ['queued', 'running'] } },
    'videoPublicId thumbnailPublicId'
  ).lean();
  for (const j of active) {
    if (j.videoPublicId) referenced.add(j.videoPublicId);
    if (j.thumbnailPublicId) referenced.add(j.thumbnailPublicId);
  }

  const assets = await listFolder();
  const cutoff = Date.now() - MIN_AGE_MS;
  const orphans = assets.filter(
    (a) => !referenced.has(a.public_id) && new Date(a.created_at).getTime() < cutoff
  );

  console.log(
    `${assets.length} assets in ${FOLDER}, ${referenced.size} referenced, ` +
      `${orphans.length} orphaned (older than 1 h):`
  );
  for (const a of orphans) {
    console.log(`  ${a.public_id}  ${a.created_at}  ${(a.bytes / 1e6).toFixed(1)} MB`);
  }

  if (!doDelete) {
    console.log(orphans.length ? '\nDry run. Re-run with --delete to remove them.' : '\nNothing to do.');
  } else {
    let deleted = 0;
    for (const a of orphans) {
      try {
        const r = await cloudinary.uploader.destroy(a.public_id, { resource_type: 'video', invalidate: true });
        if (r.result === 'ok') deleted += 1;
        else console.warn(`  ${a.public_id}: ${r.result}`);
      } catch (err) {
        console.error(`  ${a.public_id}: ${err.message}`);
      }
    }
    console.log(`\nDeleted ${deleted} of ${orphans.length}.`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
