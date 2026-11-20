const express = require('express');
const multer = require('multer');

const Channel = require('../models/channelModel');
const UploadJob = require('../models/uploadJobModel');
const catchAsync = require('../util/catchError');
const validateAfterUpload = require('../middleware/validateAfterUploadMW');
const { uploadV2Schema } = require('../validators/videoValidator');
const { cloudinary, storage } = require('../config/cloudinary');
const { runModeration, startJob } = require('../services/uploadJobRunner');
const { optionalAuth } = require('../middleware/authMW');
const { resolveActorChannel } = require('../middleware/actorMW');
const { dualModelJudges } = require('../services/dualImageModeration');

const router = express.Router();

/**
 * POST /api/v3/upload            — blocking.
 * POST /api/v3/upload?mode=async — 202 with a job id; poll /api/v2/upload/jobs/:id.
 *
 * Identical to /api/v2/upload in contract, auth, validation, cleanup and job handling.
 * The ONE difference is how images are judged: the thumbnail and the sampled frames are
 * checked by two image models, and an image counts as unsafe only when BOTH say so
 * (services/dualImageModeration.js). The text, transcript and extraction stages are the
 * shared ones in services/moderationPipeline.js.
 *
 * /api/v2/upload and the legacy /video/upload are deliberately left untouched, so older
 * app builds keep working; the helpers below are copied rather than shared for the same
 * reason — nothing in the v2 file changes.
 */

const fetchDurationSec = async (publicId) => {
  const info = await cloudinary.api.resource(publicId, {
    resource_type: 'video',
    media_metadata: true,
  });
  const duration = Number(info.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
    throw new Error(`implausible duration from Cloudinary: ${info.duration}`);
  }
  return duration;
};

const destroyQuietly = async (publicId, label) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
  } catch (err) {
    console.error(`[uploadV3] FAILED to destroy ${label} ${publicId}:`, err.message);
  }
};

router.post(
  '/upload',
  multer({ storage }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  optionalAuth,
  resolveActorChannel({ required: true }),
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
      if (!channel) return res.status(404).json({ msg: 'Channel not found' });

      const thumbnailUrl = thumbnailFile?.path ? thumbnailFile.path.replace(/\.mp4$/, '.jpg') : null;
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
        judges: dualModelJudges,
      };

      if (req.query.mode === 'async' || req.get('X-Upload-Mode') === 'async') {
        const job = await UploadJob.create({
          channel: channel._id,
          user: ctx.userId,
          status: 'queued',
          message: 'Queued',
          videoPublicId,
          thumbnailPublicId,
        });
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

      const result = await runModeration(ctx);
      if (!result.accepted) {
        return res.status(400).json({
          msg: `Upload rejected: ${result.verdict.message}`,
          stage: result.verdict.stage,
          detail: result.verdict.detail || undefined,
        });
      }
      accepted = true;
      return res.status(201).json({
        msg: '✅ Video passed moderation and was uploaded successfully',
        video: result.video,
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
