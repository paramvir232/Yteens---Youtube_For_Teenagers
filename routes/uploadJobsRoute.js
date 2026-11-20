const express = require('express');

const UploadJob = require('../models/uploadJobModel');
const UploadAttempt = require('../models/uploadAttemptModel');
const Channel = require('../models/channelModel');
const catchAsync = require('../util/catchError');
const ApiError = require('../util/apiError');
const { requireAuth, resolveChannel } = require('../middleware/authMW');
const { encodeCursor, decodeCursor } = require('../util/cursor');

const router = express.Router();

/**
 * Job status and the moderation audit trail.
 *
 * Both routes require a token and are scoped to the caller's own channel. An upload job
 * exposes the moderation verdict on someone's video, and the attempt history includes
 * the text they submitted — neither is anyone else's business, and unlike the older
 * routes these are new, so requiring auth breaks nothing.
 */

/** GET /api/v2/upload/jobs/:id — poll an async upload. */
router.get(
  '/upload/jobs/:id',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync(async (req, res) => {
    const job = await UploadJob.findById(req.params.id).lean().catch(() => null);
    if (!job) throw ApiError.notFound('JOB_NOT_FOUND', 'That upload could not be found.');

    if (String(job.channel) !== req.channelId) {
      // 404 rather than 403: telling a stranger that a job exists but is not theirs
      // leaks that it exists at all.
      throw ApiError.notFound('JOB_NOT_FOUND', 'That upload could not be found.');
    }

    res.status(200).json({
      data: {
        jobId: String(job._id),
        status: job.status,
        stage: job.stage,
        pct: job.pct,
        message: job.message,
        video: job.video ? String(job.video) : null,
      },
    });
  })
);

/**
 * GET /api/v2/upload/attempts — this channel's moderation history.
 *
 * Exists so a rejection can be reviewed. Before the UploadAttempt collection a rejected
 * upload left no trace at all: the assets were destroyed, a 400 was returned, and the
 * per-stage log was console.warn'd and dropped — so "why was my video rejected?" had no
 * answer, and neither did "is the text model over-rejecting?".
 */
router.get(
  '/upload/attempts',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    let cursorId;
    try {
      cursorId = decodeCursor(req.query.cursor);
    } catch {
      throw ApiError.badRequest('BAD_CURSOR', 'The cursor is not valid.');
    }

    const filter = { channel: req.channelId };
    if (cursorId) filter._id = { $lt: cursorId };

    const rows = await UploadAttempt.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      // `scores` is the raw per-stage moderation blob. It is kept for auditing, but
      // returning it would hand anyone a tuning oracle for the thresholds.
      .select('-scores')
      .lean();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.status(200).json({
      data: page,
      meta: {
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]._id) : null,
        hasMore,
        limit,
      },
    });
  })
);

module.exports = router;
