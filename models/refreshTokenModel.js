const mongoose = require('mongoose');

/**
 * Refresh tokens, stored hashed.
 *
 * A NEW collection. models/usersModel.js is not touched at all — existing users log in
 * with the bcrypt password they already have and get tokens from a new endpoint, so
 * there is no migration and no change to any existing document.
 *
 * ── Why the token is stored hashed, and why sha256 rather than bcrypt ─────────
 * A refresh token is a bearer credential valid for 30 days. If the database leaked and
 * tokens were stored raw, every one of them would be usable immediately. Storing a hash
 * means a leak yields nothing directly usable.
 *
 * bcrypt would be wrong here, despite being right for passwords. bcrypt is deliberately
 * slow to make guessing a low-entropy human password expensive. A refresh token is 32
 * bytes from crypto.randomBytes — there is nothing to guess, so the slowness buys no
 * security and costs a bcrypt round on every single refresh. sha256 is the correct tool
 * for hashing a high-entropy secret.
 *
 * ── The `family` field ────────────────────────────────────────────────────────
 * Tokens rotate: each refresh issues a new one and revokes the old. All descendants of
 * one login share a `family` id. If a token that has already been rotated is presented
 * again, that is a replay — either the user restored an old backup, or a token was
 * stolen and used by both parties. We cannot tell which, so the whole family is revoked
 * and everyone re-authenticates. That is the standard reuse-detection pattern and it is
 * the main reason to rotate at all.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    // sha256 hex of the raw token. Unique so a hash collision or a duplicate insert is
    // a database error rather than two valid tokens.
    tokenHash: { type: String, required: true, unique: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Shared by every token descended from one login.
    family: { type: String, required: true, index: true },

    // TTL index: Mongo deletes expired rows itself, so the collection does not grow
    // without bound and no cleanup job is needed.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },

    revokedAt: { type: Date, default: null },

    // The hash of the token that replaced this one. Present means "rotated"; combined
    // with revokedAt it is what distinguishes a replay from an ordinary expired token.
    replacedBy: { type: String, default: null },

    // Forensics only. Never used for authorisation — a client controls both of these.
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
