const mongoose = require('mongoose');

/**
 * An upload being moderated in the background.
 *
 * ── Why asynchronous moderation is necessary, not a nicety ───────────────────
 * `moderateUpload` can legitimately take minutes: the transcript call alone has a
 * 180-second timeout, and a long video can mean up to 30 sequential image-moderation
 * calls at 30 seconds each. A single HTTP request cannot survive that. Render's free
 * tier, most reverse proxies and the client's own axios timeout will all cut it long
 * before the work finishes — and the server would go on to accept the video, so the
 * user sees a failure for an upload that actually succeeded, with the video appearing
 * later as if by accident.
 *
 * Reporting progress on that request does not help: the request is the thing being
 * killed. So the bytes are accepted, a job row is created, 202 is returned immediately,
 * and the client polls this record.
 *
 * ── The honest limitation ────────────────────────────────────────────────────
 * The work runs IN-PROCESS via setImmediate — no Redis, no worker, no new
 * infrastructure, which is the right trade for a single dyno. The cost is that a
 * restart mid-moderation strands a job in `running` forever. `heartbeatAt` plus a
 * startup sweep marks those failed. The upgrade path, if this ever outgrows one
 * process, is a real queue (BullMQ); nothing here assumes it stays in-process except
 * the sweep.
 */
const uploadJobSchema = new mongoose.Schema(
  {
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    status: {
      type: String,
      enum: ['queued', 'running', 'accepted', 'rejected', 'failed'],
      default: 'queued',
      index: true,
    },

    // Which gate is running, for a meaningful progress message rather than a spinner.
    stage: { type: String, default: null },
    pct: { type: Number, default: 0 },
    message: { type: String, default: '' },

    video: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },
    attempt: { type: mongoose.Schema.Types.ObjectId, ref: 'UploadAttempt', default: null },

    // Kept so the sweep can clean up assets belonging to a stranded job.
    videoPublicId: { type: String, default: '' },
    thumbnailPublicId: { type: String, default: '' },

    // Bumped as each stage completes. A `running` job whose heartbeat is old means the
    // process that owned it died.
    heartbeatAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Jobs are a transient progress record, not history — the audit lives in
// UploadAttempt. A week is long enough for any client to finish polling.
uploadJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
uploadJobSchema.index({ channel: 1, createdAt: -1 });

module.exports = mongoose.model('UploadJob', uploadJobSchema);
