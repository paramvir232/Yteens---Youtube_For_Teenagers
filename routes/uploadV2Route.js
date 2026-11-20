const express = require('express');
const router = express.Router();

const Video = require('../models/videoModel');
const Channel = require('../models/channelModel');
const Transcript = require('../models/transcriptModel');
const catchAsync = require('../util/catchError');
const validateAfterUpload = require('../middleware/validateAfterUploadMW');
const { uploadV2Schema } = require('../validators/videoValidator');
const { cloudinary, storage } = require('../config/cloudinary');
const UploadJob = require('../models/uploadJobModel');
const { runModeration, startJob } = require('../services/uploadJobRunner');
const { optionalAuth } = require('../middleware/authMW');
const { resolveActorChannel } = require('../middleware/actorMW');
const multer = require('multer');

let durationLogged = false;

const fetchDurationSec = async (publicId) => {

  const info = await cloudinary.api.resource(publicId, {
    resource_type: 'video',
    media_metadata: true
  });

  if (!durationLogged) {
    durationLogged = true;
    console.log(
      '[uploadV2] first Cloudinary resource response (confirm duration units):',
      JSON.stringify({
        duration: info.duration,
        width: info.width,
        height: info.height,
        format: info.format,
        bytes: info.bytes
      })
    );
  }

  const duration = Number(info.duration);

  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
    throw new Error(
      `implausible duration from Cloudinary: ${info.duration} ` +
        '(is media_metadata still being requested?)'
    );
  }
  return duration;
};

const destroyQuietly = async (publicId, label) => {
  if (!publicId) return;
  try {

    await cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
  } catch (err) {

    console.error(`[uploadV2] FAILED to destroy ${label} ${publicId}:`, err.message);
  }
};

/**
 * POST /api/v2/upload           — blocking. Unchanged behaviour.
 * POST /api/v2/upload?mode=async — returns 202 with a job id; poll for the result.
 *
 * Async mode exists because the blocking path cannot survive deployment. moderateUpload
 * can take minutes (a 180s transcript timeout, then up to 30 sequential 30s image
 * calls), and Render's free tier, most proxies and the client's own axios timeout will
 * all cut the request first — while the server goes on to accept the video. The user
 * sees a failure for an upload that worked.
 *
 * The blocking path is kept exactly as it was, because scripts/pipelineLiveCheck.js
 * drives it and anything already pointing at it must keep working.
 *
 * The uploading channel comes from the TOKEN. It used to come from a `channelId` form
 * field that nothing verified, which is the same impersonation hole the legacy routes
 * had — and since this is the route the app now uploads through, leaving it open would
 * have made closing the others pointless. scripts/pipelineLiveCheck.js is unaffected:
 * it calls moderateUpload() directly and never touches this route.
 */
router.post(
  '/upload',

  multer({ storage }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
  ]),

  optionalAuth,
  resolveActorChannel({ required: true }),
  // Before validation, so the schema still sees the channelId it requires and a form
  // field naming someone else's channel is discarded rather than rejected.
  (req, res, next) => {
    req.body = req.body || {};
    req.body.channelId = req.actorChannelId;
    next();
  },
  validateAfterUpload(uploadV2Schema),
  catchAsync(async (req, res) => {
    const { title, description, tags, channelId } = req.body;

    const videoFile = req.files?.video?.[0];
    const thumbnailFile = req.files?.thumbnail?.[0];

    const videoPublicId = videoFile?.filename;
    const thumbnailPublicId = thumbnailFile?.filename;

    let accepted = false;

    try {
      if (!videoFile || !videoFile.path) {
        return res.status(400).json({ msg: 'No video uploaded' });
      }

      const channel = await Channel.findById(channelId);
      if (!channel) {
        return res.status(404).json({ msg: 'Channel not found' });
      }

      const thumbnailUrl = thumbnailFile?.path
        ? thumbnailFile.path.replace(/\.mp4$/, '.jpg')
        : null;

      const durationSec = await fetchDurationSec(videoPublicId);

      const ctx = {
        channel,
        title,
        description,
        tags,
        videoUrl: videoFile.path,
        thumbnailUrl,
        videoPublicId,
        thumbnailPublicId,
        durationSec,
        userId: req.auth?.userId ?? null,
      };

      // --- async mode: hand back a job and moderate in the background ---------------
      if (req.query.mode === 'async' || req.get('X-Upload-Mode') === 'async') {
        const job = await UploadJob.create({
          channel: channel._id,
          user: ctx.userId,
          status: 'queued',
          message: 'Queued',
          videoPublicId,
          thumbnailPublicId,
        });

        // The assets must survive this request so the background work can use them;
        // the job's own cleanup destroys them if it rejects or fails.
        accepted = true;

        startJob(job._id, ctx, async () => {
          await destroyQuietly(videoPublicId, 'video');
          await destroyQuietly(thumbnailPublicId, 'thumbnail');
        });

        return res.status(202).json({
          data: {
            jobId: String(job._id),
            status: 'queued',
            statusUrl: `/api/v2/upload/jobs/${job._id}`,
          },
        });
      }

      // --- blocking mode: unchanged -------------------------------------------------
      const result = await runModeration(ctx);

      if (!result.accepted) {
        return res.status(400).json({
          msg: `Upload rejected: ${result.verdict.message}`,
          // Additive. The original `msg` is untouched, so an existing client that reads
          // only that keeps working; a new one can branch on the stage and tell the user
          // which part of their upload to change.
          stage: result.verdict.stage,
          detail: result.verdict.detail || undefined,
        });
      }

      accepted = true;

      return res.status(201).json({
        msg: '✅ Video passed moderation and was uploaded successfully',
        video: result.video
      });
    } finally {
      if (!accepted) {
        await destroyQuietly(videoPublicId, 'video');
        await destroyQuietly(thumbnailPublicId, 'thumbnail');
      }
    }
  })
);

module.exports = router;
