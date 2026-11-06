const Channel = require('../models/channelModel');
const { verifyAccessToken } = require('../services/tokenService');

/**
 * Authentication middleware.
 *
 * Three pieces, used in different places:
 *
 *   requireAuth     — 401 unless a valid access token is present. For new endpoints only.
 *   optionalAuth    — attaches req.auth when a token is present; continues when absent.
 *   resolveChannel  — turns req.auth.userId into req.channelId.
 *
 * ── Why optionalAuth still rejects a BAD token ───────────────────────────────
 * "Optional" means the header may be absent. It does not mean a malformed or expired
 * token is ignored — silently treating a bad token as "no token" would hide client bugs
 * (an expired token that is never refreshed looks like a working anonymous session) and
 * make debugging a broken auth flow nearly impossible. Absent is fine; wrong is an error.
 *
 * ── The existing routes ARE now protected ────────────────────────────────────
 * This file once said they were not, because the frontend had no token to send. It
 * does now, so every write on videoRoute, channelRoute and usersRoute is closed: they
 * go through optionalAuth + resolveActorChannel (actorMW), which 401s without a token,
 * and then through an ownership check (ownershipMW), because being signed in is not
 * the same as being the owner.
 *
 * Reads stay open. The video and channel listings are public and the legacy contract
 * test holds them that way.
 */

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

const unauthorized = (res, code, message) =>
  res.status(401).json({ error: { code, message } });

function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return unauthorized(res, 'TOKEN_MISSING', 'Sign in to continue.');

  try {
    req.auth = verifyAccessToken(token);
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return unauthorized(
      res,
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      expired ? 'Your session has expired.' : 'Your session is not valid.'
    );
  }
}

function optionalAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return next();

  try {
    req.auth = verifyAccessToken(token);
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return unauthorized(
      res,
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      expired ? 'Your session has expired.' : 'Your session is not valid.'
    );
  }
}

/**
 * Resolve the authenticated user's channel into req.channelId.
 *
 * Looked up per request rather than carried in the token: a channel can be created or
 * deleted at any time, and a claim baked into a 15-minute token would be wrong for up
 * to 15 minutes. Channel.user is unique and indexed, so this is one key lookup.
 */
const resolveChannel = ({ required = false } = {}) => async (req, res, next) => {
  if (!req.auth) {
    if (required) return unauthorized(res, 'TOKEN_MISSING', 'Sign in to continue.');
    return next();
  }

  try {
    const channel = await Channel.findOne({ user: req.auth.userId }).select('_id').lean();
    req.channelId = channel ? String(channel._id) : null;

    if (required && !req.channelId) {
      return res.status(403).json({
        error: {
          code: 'NO_CHANNEL',
          message: 'Create a channel before doing this.',
        },
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { requireAuth, optionalAuth, resolveChannel, extractBearer };
