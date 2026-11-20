/**
 * Opaque pagination cursors.
 *
 * A cursor is just a base64url-encoded ObjectId, but it is encoded rather than passed
 * raw for two reasons: clients cannot hand-construct one and assume it means "the
 * video with this id", and the internals can change later (to a compound
 * timestamp+id key, say) without a new API version.
 *
 * ── Why _id and not uploadedAt or createdAt ───────────────────────────────────
 * Both date fields are non-unique, so two videos saved in the same millisecond have no
 * defined relative order; a page boundary that lands between them can repeat one and
 * skip the other. They are also set at different moments - `uploadedAt` defaults to
 * Date.now at document construction, `createdAt` is written by the timestamps plugin -
 * so they can disagree, and nothing stops `uploadedAt` being back-dated later.
 *
 * _id is unique, immutable, already indexed, and its leading four bytes are a Unix
 * timestamp, so sorting by it descending is "newest first" with a total order and a
 * free tiebreak. Paging with { _id: { $lt: cursor } } also means a video uploaded
 * mid-scroll has a LARGER _id than the cursor and therefore falls outside the window
 * entirely: the reader walks a frozen prefix instead of seeing a duplicate.
 *
 * The caveat, for anyone reusing this: ObjectId order is generation order, and across
 * processes the machine/counter bytes mean two documents created in the same second can
 * order differently from their true creation time. Invisible in a feed. Do not reuse
 * this cursor for anything needing exact chronology.
 */
const mongoose = require('mongoose');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function encodeCursor(id) {
  if (!id) return null;
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

/**
 * Decode a cursor to an ObjectId.
 * Returns null for a missing cursor; throws for a malformed one, so a typo surfaces as
 * a 400 rather than silently resetting the reader to page one.
 */
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;

  let decoded;
  try {
    decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  } catch {
    throw new Error('Malformed cursor');
  }

  if (!OBJECT_ID_RE.test(decoded)) throw new Error('Malformed cursor');
  return new mongoose.Types.ObjectId(decoded);
}

module.exports = { encodeCursor, decodeCursor };
