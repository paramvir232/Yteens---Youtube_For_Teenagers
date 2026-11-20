const mongoose = require('mongoose');

/**
 * A comment, or a reply to a comment.
 *
 * `parent` is the reply reference: null for a top-level comment, otherwise the comment
 * being replied to. `depth` is capped so a thread cannot be nested indefinitely — both
 * because the UI renders one level of nesting, and because an unbounded chain makes
 * building the tree unbounded work.
 *
 * `post` is denormalised onto every comment, including deep replies, so fetching a
 * whole thread is one indexed query rather than a recursive walk.
 */
const MAX_DEPTH = 3;

const communityCommentSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },

    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityComment', default: null },
    depth: { type: Number, default: 0, max: MAX_DEPTH },

    body: { type: String, required: true, maxlength: 2000 },

    status: { type: String, enum: ['visible', 'removed'], default: 'visible' },
    moderation: { type: mongoose.Schema.Types.Mixed, default: null },

    voteCount: { type: Number, default: 0 },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null },
  },
  { timestamps: true }
);

communityCommentSchema.index({ post: 1, status: 1, _id: 1 });
communityCommentSchema.index({ parent: 1, _id: 1 });

module.exports = mongoose.model('CommunityComment', communityCommentSchema);
module.exports.MAX_DEPTH = MAX_DEPTH;
