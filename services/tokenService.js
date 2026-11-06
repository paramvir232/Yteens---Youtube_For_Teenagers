const crypto = require('crypto');
const { numberFromEnv } = require('../config/devDefaults');
const jwt = require('jsonwebtoken');

const RefreshToken = require('../models/refreshTokenModel');

/**
 * All token logic, so routes stay thin and this can be unit-tested with no HTTP.
 *
 * Two different kinds of credential, chosen for different reasons:
 *
 *   Access token  — a short-lived JWT. Stateless, so checking one is a signature verify
 *                   with no database round trip, which is what makes it cheap enough to
 *                   do on every request. The cost of stateless is that it cannot be
 *                   revoked, which is why it lasts 15 minutes.
 *   Refresh token — opaque random bytes, stored hashed. Not a JWT: there is nothing to
 *                   put in it, it must be revocable, and a long-lived JWT would be a
 *                   30-day credential nobody can cancel.
 *
 * ── What is deliberately NOT in the access token ─────────────────────────────
 * The channel id. A user can create or delete a channel at any moment, so a `cid` claim
 * would be stale for up to 15 minutes — long enough for a deleted channel to keep
 * acting, or a new one to be invisible. The channel is resolved per request instead;
 * Channel.user is already a unique index, so it is a single-key lookup.
 */

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = numberFromEnv('REFRESH_TOKEN_TTL_DAYS', 30);

function accessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
  return secret;
}

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function signAccessToken(userId) {
  return jwt.sign(
    { sub: String(userId), typ: 'access' },
    accessSecret(),
    { expiresIn: ACCESS_TTL, jwtid: crypto.randomUUID() }
  );
}

/**
 * Verify an access token. Returns { userId } or throws.
 *
 * The `typ` check matters: without it a refresh token that happened to be a JWT, or any
 * other token signed with the same secret, would be accepted as an access token.
 */
function verifyAccessToken(token) {
  const payload = jwt.verify(token, accessSecret());
  if (payload.typ !== 'access') throw new Error('Wrong token type');
  return { userId: payload.sub };
}

function newRefreshTokenValue() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Mint a refresh token at the head of a NEW family. Used at login. */
async function issueRefreshToken(userId, meta = {}) {
  const raw = newRefreshTokenValue();
  await RefreshToken.create({
    tokenHash: hashToken(raw),
    user: userId,
    family: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent || '',
    ip: meta.ip || '',
  });
  return raw;
}

class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.statusCode = 401;
  }
}

/**
 * Exchange a refresh token for a new pair, rotating it.
 *
 * Returns { accessToken, refreshToken, userId }, or throws a TokenError.
 *
 * The reuse case is the interesting one. A token that has already been rotated should
 * never be presented again — the client replaced it. If one is, either an old copy was
 * restored or a token was stolen and is being used by two parties at once. We cannot
 * tell which, so every token in the family is revoked. That turns a silent, open-ended
 * compromise into one forced re-login.
 */
async function rotateRefreshToken(raw, meta = {}) {
  if (!raw) throw new TokenError('TOKEN_MISSING', 'No refresh token supplied.');

  const existing = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
  if (!existing) throw new TokenError('TOKEN_INVALID', 'Refresh token is not recognised.');

  if (existing.revokedAt) {
    await RefreshToken.updateMany(
      { family: existing.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw new TokenError(
      'TOKEN_REUSED',
      'This refresh token was already used. All sessions have been signed out.'
    );
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new TokenError('TOKEN_EXPIRED', 'Refresh token has expired.');
  }

  const nextRaw = newRefreshTokenValue();
  const nextHash = hashToken(nextRaw);

  await RefreshToken.create({
    tokenHash: nextHash,
    user: existing.user,
    family: existing.family, // same family: this is a rotation, not a new login
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent || '',
    ip: meta.ip || '',
  });

  existing.revokedAt = new Date();
  existing.replacedBy = nextHash;
  await existing.save();

  return {
    accessToken: signAccessToken(existing.user),
    refreshToken: nextRaw,
    userId: existing.user,
  };
}

/** Revoke one token. Idempotent: logging out twice is not an error. */
async function revokeRefreshToken(raw) {
  if (!raw) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(raw), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

/** Revoke every live token for a user. "Sign out everywhere". */
async function revokeAllForUser(userId) {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  hashToken,
  TokenError,
  ACCESS_TTL,
};
