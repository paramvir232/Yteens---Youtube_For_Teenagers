const express = require('express');
const rateLimit = require('express-rate-limit');

const User = require('../models/usersModel');
const Channel = require('../models/channelModel');
const catchAsync = require('../util/catchError');
const { requireAuth } = require('../middleware/authMW');
const {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  TokenError,
  ACCESS_TTL,
} = require('../services/tokenService');

const router = express.Router();

/**
 * Token authentication, mounted at /api/v2/auth.
 *
 * Entirely new routes. POST /user/login still exists, still returns exactly what it
 * always did, and still issues no credential — nothing that depends on it changes.
 * Existing users need no migration: their bcrypt password already verifies, so logging
 * in here mints tokens for an account created years ago.
 *
 * ── Rate limiting ────────────────────────────────────────────────────────────
 * Login runs bcrypt on every attempt, which is deliberately expensive — that is the
 * point of bcrypt. Unlimited, it is a free CPU-exhaustion target as well as an
 * unlimited password-guessing oracle. The limiter applies only to these new routes, so
 * no existing endpoint changes behaviour.
 */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
  },
});

// Refresh is called legitimately far more often than login — every 15 minutes per
// active client, plus once on each cold start — so it gets its own, looser budget.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
  },
});

const meta = (req) => ({
  userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
  ip: req.ip || '',
});

/** The user plus their channel, in the shape the client wants after signing in. */
async function sessionPayload(user) {
  const channel = await Channel.findOne({ user: user._id })
    .select('_id name profileImage')
    .lean();

  return {
    user: { id: String(user._id), userName: user.userName, email: user.email },
    channel: channel
      ? { id: String(channel._id), name: channel.name, profileImage: channel.profileImage }
      : null,
  };
}

/**
 * POST /api/v2/auth/login
 *
 * Note the identical 401 for "no such user" and "wrong password". The legacy
 * /user/login returns 404 for the first and 401 for the second, which is a user
 * enumeration oracle: anyone can discover whether an email has an account. Fixed here;
 * the old route is left exactly as it is.
 */
router.post(
  '/login',
  authLimiter,
  catchAsync(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email and password are required.' },
      });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    const ok = user ? await user.comparePassword(password) : false;
    if (!ok) {
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
      });
    }

    const refreshToken = await issueRefreshToken(user._id, meta(req));

    res.status(200).json({
      data: {
        accessToken: signAccessToken(user._id),
        expiresIn: ACCESS_TTL,
        refreshToken,
        ...(await sessionPayload(user)),
      },
    });
  })
);

/** POST /api/v2/auth/refresh — rotates the refresh token and returns a new pair. */
router.post(
  '/refresh',
  refreshLimiter,
  catchAsync(async (req, res) => {
    const { refreshToken } = req.body || {};

    try {
      const rotated = await rotateRefreshToken(refreshToken, meta(req));
      return res.status(200).json({
        data: {
          accessToken: rotated.accessToken,
          expiresIn: ACCESS_TTL,
          refreshToken: rotated.refreshToken,
        },
      });
    } catch (err) {
      if (err instanceof TokenError) {
        return res.status(401).json({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  })
);

/**
 * POST /api/v2/auth/logout — revoke one token.
 *
 * Deliberately 204 whether or not the token existed. A client signing out should never
 * be told "that token was not recognised", and reporting it would let an attacker probe
 * which tokens are live.
 */
router.post(
  '/logout',
  catchAsync(async (req, res) => {
    await revokeRefreshToken(req.body?.refreshToken);
    res.status(204).end();
  })
);

/** POST /api/v2/auth/logout-all — revoke every session for the signed-in user. */
router.post(
  '/logout-all',
  requireAuth,
  catchAsync(async (req, res) => {
    await revokeAllForUser(req.auth.userId);
    res.status(204).end();
  })
);

/**
 * GET /api/v2/auth/me — the signed-in user and their channel.
 *
 * This removes an O(n) request from every sign-in. The client used to download EVERY
 * channel in the system and scan for the one whose `user._id` matched, because there was
 * no endpoint that would just tell it. Channel.user is unique and indexed, so this is a
 * single key lookup.
 */
router.get(
  '/me',
  requireAuth,
  catchAsync(async (req, res) => {
    const user = await User.findById(req.auth.userId).select('-password').lean();
    if (!user) {
      return res.status(401).json({
        error: { code: 'TOKEN_INVALID', message: 'Your session is not valid.' },
      });
    }
    res.status(200).json({ data: await sessionPayload(user) });
  })
);

module.exports = router;
