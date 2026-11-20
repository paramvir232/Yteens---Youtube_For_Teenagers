const mongoose = require('mongoose');

/**
 * Every moderated upload attempt, accepted or rejected.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Today a rejected upload leaves NO trace anywhere. The Cloudinary assets are destroyed
 * in a finally block, a 400 goes back to the client, and the full per-stage moderation
 * log — which `moderateUpload` has already computed in `verdict.log.stages` — is
 * console.warn'd and discarded.
 *
 * That makes several ordinary questions unanswerable: how many uploads were rejected
 * this week, is the text model over-rejecting, is one channel repeatedly submitting the
 * same unsafe content, and — most importantly — was THIS rejection correct? Without the
 * submitted text there is no way to review a false positive, which is exactly the
 * complaint a user will bring.
 *
 * A NEW collection, so `videos` gains no status field and no existing document changes.
 *
 * ── Retention ────────────────────────────────────────────────────────────────
 * The submitted title and description are kept verbatim, because a moderation audit
 * without the moderated text is useless. They are user-written content, so the records
 * expire after 180 days via a TTL index rather than accumulating forever.
 */
const uploadAttemptSchema = new mongoose.Schema(
  {
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', index: true },
    // Set only when the request carried a token. Null for legacy body-identified calls.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    outcome: {
      type: String,
      enum: ['accepted', 'rejected', 'error'],
      required: true,
      index: true,
    },

    // Which gate rejected it: text | thumbnail | frames | transcript | unavailable.
    stage: { type: String, default: null },
    message: { type: String, default: '' },
    detail: { type: String, default: '' },

    // The submitted text, verbatim. Without it a false positive cannot be reviewed.
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    tags: { type: [String], default: [] },

    // Recorded even though the assets are destroyed on rejection, so an orphaned asset
    // can be reconciled against the attempt that created it.
    videoPublicId: { type: String, default: '' },
    thumbnailPublicId: { type: String, default: '' },
    durationSec: { type: Number, default: null },

    // The whole verdict.log.stages blob: per-stage safe flags, chunk counts, max scores,
    // flagged frame index. Mixed because its shape belongs to the moderation services,
    // not to us, and pinning a schema would mean editing this file whenever they change.
    scores: { type: mongoose.Schema.Types.Mixed, default: null },

    video: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'UploadJob', default: null },
  },
  { timestamps: true }
);

// 180-day TTL. `expires` on createdAt rather than a separate field, so nothing has to
// remember to set it.
uploadAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
uploadAttemptSchema.index({ channel: 1, createdAt: -1 });
uploadAttemptSchema.index({ outcome: 1, createdAt: -1 });

module.exports = mongoose.model('UploadAttempt', uploadAttemptSchema);
