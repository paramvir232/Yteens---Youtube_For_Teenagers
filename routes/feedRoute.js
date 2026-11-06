const express = require('express');

const Video = require('../models/videoModel');
const catchAsync = require('../util/catchError');
const ApiError = require('../util/apiError');
const { encodeCursor, decodeCursor } = require('../util/cursor');
const validateQuery = require('../middleware/joiQueryMW');
const { feedQuerySchema } = require('../validators/feedValidator');

const router = express.Router();

/**
 * The paginated feed.
 *
 * GET /api/v2/feed?cursor=&limit=20&q=&tag=&channel=
 *   -> { data: [...], meta: { nextCursor, hasMore, limit } }
 *
 * This exists ALONGSIDE GET /video/, which is unchanged and still returns the entire
 * collection as a bare array. Existing clients keep working; nothing is migrated.
 *
 * ── The projection is the actual performance fix ──────────────────────────────
 * GET /video/ returns full documents, which means every element of views.viewers,
 * likes.by and comments for every video - arrays that grow without bound as the site is
 * used. A feed of 25 videos can therefore carry thousands of ObjectIds the home screen
 * never reads; it only needs counts.
 *
 * Mongoose has no "project an array's length" operator in find(), so the counts are
 * computed after the fetch. That still avoids the expensive part (serialising and
 * transferring the arrays over the wire to the client), which is where the cost is.
 * If these arrays ever get large enough that loading them into the app server matters,
 * the fix is an aggregation with $size - deliberately not done now, because it would
 * mean maintaining a second query shape for a cost that is not yet real.
 */

const LIST_FIELDS = 'title description url thumbnailUrl tags channel uploadedAt createdAt views.count likes.count';

/** Escape a user string so it cannot act as a regex. */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get(
  '/feed',
  validateQuery(feedQuerySchema),
  catchAsync(async (req, res) => {
    const { limit, cursor, q, tag, channel } = req.validatedQuery;

    let cursorId;
    try {
      cursorId = decodeCursor(cursor);
    } catch {
      throw ApiError.badRequest('BAD_CURSOR', 'The cursor is not valid.');
    }

    const filter = {};
    if (cursorId) filter._id = { $lt: cursorId };
    if (tag) filter.tags = tag;
    if (channel) filter.channel = channel;
    if (q) {
      const pattern = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ title: pattern }, { tags: pattern }];
    }

    // Fetch one extra row to learn whether another page exists, without a second
    // countDocuments query over the whole collection.
    const rows = await Video.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .select(LIST_FIELDS)
      .populate('channel', 'name profileImage')
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
