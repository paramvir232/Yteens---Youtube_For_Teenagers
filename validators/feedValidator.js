const Joi = require('joi');

/**
 * Query schema for GET /api/v2/feed.
 *
 * `limit` is clamped to 50 rather than rejected above it. A client asking for 1000 gets
 * 50 and a working feed; rejecting would turn a client bug into a broken screen. The
 * ceiling exists because the whole point of this endpoint is that no request can ever
 * return the entire collection - which is what GET /video/ does today and why the app is
 * slow to start.
 *
 * `q` is capped at 100 characters because it becomes a regex (escaped) against title and
 * tags; an unbounded pattern is a cheap way to make the database work hard.
 */
const feedQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(20),
  cursor: Joi.string().trim().max(200).optional(),
  q: Joi.string().trim().max(100).allow('').optional(),
  tag: Joi.string().trim().max(50).optional(),
  channel: Joi.string().trim().hex().length(24).optional(),
});

module.exports = { feedQuerySchema };
