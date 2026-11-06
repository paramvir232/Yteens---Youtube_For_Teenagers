const Video = require('../models/videoModel');

/**
 * Ownership checks for the pre-existing routes.
 *
 * ── Why requireAuth alone would not have been the fix ────────────────────────
 * Requiring a token proves the caller is *somebody*. It does not prove they are the
 * right somebody. `DELETE /channel/delete/:id` with nothing but requireAuth still lets
 * any signed-in teenager delete any other channel on the platform — it narrows the set
 * of attackers from "everyone" to "everyone with an account", which for a public
 * sign-up is not a meaningful narrowing.
 *
 * So every write that names a resource in its URL gets one of these, and the acting
 * channel comes from the token (req.actorChannelId / req.channelId), never from the
 * body.
 *
 * ── 404 vs 403 ───────────────────────────────────────────────────────────────
 * These answer 403 for a resource that exists but is not yours, because the ids here
 * are not secret: they appear in the public /video/ and /channel/ listings, so hiding
 * existence buys nothing and a 403 is the more useful answer. The community routes make
 * the opposite choice, deliberately, because an upload job id is not public.
 */

const forbidden = (res, message) =>
  res.status(403).json({ error: { code: 'NOT_OWNER', message } });

/** The channel acting on this request, whichever middleware resolved it. */
const actorOf = (req) => req.actorChannelId || req.channelId || null;

/**
 * The :id in the URL must be the caller's own channel.
 *
 * Used by updateDetails and channel delete.
 */
const ownsChannelParam = (param = 'id') => (req, res, next) => {
  const actor = actorOf(req);
  if (!actor) return forbidden(res, 'Create a channel before doing this.');
  if (String(req.params[param]) !== String(actor)) {
    return forbidden(res, 'You can only change your own channel.');
  }
  return next();
};

/**
 * The video named by :id must belong to the caller's channel.
 *
 * Loads the video and hands it to the handler on req.video, so the handler does not
 * fetch it a second time.
 */
const ownsVideoParam = (param = 'id') => async (req, res, next) => {
  try {
    const actor = actorOf(req);
    if (!actor) return forbidden(res, 'Create a channel before doing this.');

    const video = await Video.findById(req.params[param]);
    if (!video) return res.status(404).json({ msg: 'Video not found' });

    if (String(video.channel) !== String(actor)) {
      return forbidden(res, 'You can only change your own videos.');
    }

    req.video = video;
    return next();
  } catch (err) {
    return next(err);
  }
};

/** The :id in the URL must be the caller's own user record. */
const isSelfParam = (param = 'id') => (req, res, next) => {
  if (!req.auth?.userId) {
    return res.status(401).json({ error: { code: 'TOKEN_MISSING', message: 'Sign in to continue.' } });
  }
  if (String(req.params[param]) !== String(req.auth.userId)) {
    return forbidden(res, 'You can only change your own account.');
  }
  return next();
};

/**
 * A comment may be removed by its author or by the owner of the video it is on.
 *
 * Not a middleware: it needs the comment subdocument, which only the handler has.
 */
const canDeleteComment = (comment, video, actorChannelId) => {
  if (!actorChannelId) return false;
  const actor = String(actorChannelId);
  return String(comment.channel) === actor || String(video.channel) === actor;
};

module.exports = {
  ownsChannelParam,
  ownsVideoParam,
  isSelfParam,
  canDeleteComment,
  actorOf,
};
