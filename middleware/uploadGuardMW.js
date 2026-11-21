const Channel = require('../models/channelModel');
const { verifyAccessToken } = require('../services/tokenService');
const { extractBearer } = require('./authMW');
const { destroyCloudinaryAsset } = require('../util/cloudinaryAsset');

/**
 * Two guards for the upload routes (POST /api/v2/upload, /api/v3/upload, /video/upload),
 * mounted in app.js in front of the routers.
 *
 * ── The leak they close ──────────────────────────────────────────────────────
 * Every upload route runs multer FIRST, and multer streams both files straight into
 * Cloudinary. Only after that do the token and channel checks run. So a request that was
 * always going to fail - no token, an access token that expired during a slow phone
 * upload, a stale session from an old app build, a user with no channel - paid for a full
 * upload, got a 401/403 from a middleware that never cleans up, and left the video in
 * Cloudinary forever. Observed: an old APK upload against the live backend failed with no
 * route log line at all, and its video stayed in the account.
 *
 * 1. earlyUploadAuth checks the token and the channel BEFORE multer, so a request that
 *    cannot succeed is answered before any byte reaches Cloudinary. The bodies and codes
 *    are exactly the ones optionalAuth / resolveActorChannel send today, so clients see
 *    the same error, just without the wasted upload. On success it sets req.auth, and
 *    optionalAuth then does not re-verify - a token that was valid when the upload started
 *    stays valid for that request, however long the upload takes.
 *
 * 2. cleanupUploadsOnFailure is the safety net for everything else: whenever the response
 *    is an error (status >= 400), or the client goes away before a response, every file
 *    multer stored is destroyed. A 201/202 keeps them (the async job owns them from then
 *    on). Routes that already clean up on rejection make this a second, harmless delete -
 *    Cloudinary answers "not found".
 *
 * With LEGACY_ACTOR_FALLBACK=true (body channelId as identity, a rollback switch) a request
 * with no token cannot be judged before multer parses the body, so it is passed through
 * unchanged; the safety net still cleans up if it fails.
 */

const reply = (res, status, code, message) => res.status(status).json({ error: { code, message } });

async function earlyUploadAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) {
      if (process.env.LEGACY_ACTOR_FALLBACK === 'true') return next();
      return reply(res, 401, 'TOKEN_MISSING', 'Sign in to continue.');
    }

    try {
      req.auth = verifyAccessToken(token);
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      return reply(
        res,
        401,
        expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        expired ? 'Your session has expired.' : 'Your session is not valid.'
      );
    }

    const channel = await Channel.findOne({ user: req.auth.userId }).select('_id').lean();
    if (!channel) {
      return reply(res, 403, 'NO_CHANNEL', 'Create a channel before doing this.');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

const storedFiles = (req) =>
  [...Object.values(req.files || {}).flat(), ...(req.file ? [req.file] : [])].filter(
    (f) => f && f.path
  );

function cleanupUploadsOnFailure(req, res, next) {
  let finished = false;
  let cleaned = false;

  const cleanup = async (why) => {
    if (cleaned) return;
    cleaned = true;
    const files = storedFiles(req);
    if (!files.length) return;
    for (const file of files) {
      const result = await destroyCloudinaryAsset(file.path, file.fieldname || 'upload');
      if (!result.deleted && result.reason !== 'not found') {
        console.warn(
          `[uploadGuard] ${why}: could not remove ${file.fieldname} ` +
            `(${result.reason}) - public_id ${result.publicId}`
        );
      }
    }
  };

  res.on('finish', () => {
    finished = true;
    if (res.statusCode >= 400) cleanup(`failed with ${res.statusCode}`);
  });
  // 'close' also fires after a normal finish; only a close WITHOUT a response is an abort.
  res.on('close', () => {
    if (!finished) cleanup('client went away');
  });

  next();
}

module.exports = { earlyUploadAuth, cleanupUploadsOnFailure, storedFiles };
