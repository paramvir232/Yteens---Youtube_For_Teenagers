const mongoose = require('mongoose');

/**
 * Content that was rejected before it could be published.
 *
 * A rejected post never reaches communityPosts, so without this row the submission
 * would vanish entirely — the same gap uploadAttempts closes for videos. Without the
 * text, "my post was wrongly blocked" is unanswerable.
 *
 * 90-day TTL: it is user-written content kept for review, not a permanent record.
 */
const communityModerationLogSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },

    kind: { type: String, enum: ['post', 'comment'], required: true },
    // The post a rejected comment was aimed at, where there is one.
    parentRef: { type: mongoose.Schema.Types.ObjectId, default: null },

    body: { type: String, default: '' },
    imageUrl: { type: String, default: '' },

    stage: { type: String, default: null },   // 'text' | 'image'
    reason: { type: String, default: '' },
    scores: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

communityModerationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
communityModerationLogSchema.index({ community: 1, createdAt: -1 });

module.exports = mongoose.model('CommunityModerationLog', communityModerationLogSchema);
