const mongoose = require('mongoose');

/**
 * A post in a channel's community.
 *
 * Only ever written with status 'visible': moderation runs BEFORE the insert, so a
 * post that failed is never in this collection at all. A rejection is recorded in
 * communityModerationLogs instead, so a false positive can still be reviewed.
 *
 * `imageUrl` holds a Cloudinary URL. Images must reach Cloudinary before they can be
 * moderated, because moderateImage takes a URL — so the flow is upload, moderate,
 * destroy on rejection, exactly as the video upload route does it.
 */
const communityPostSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    // The author is a CHANNEL, matching how subscription and membership work.
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },

    title: { type: String, default: '', trim: true, maxlength: 200 },
    // Capped at 5000 because the body is chunked into ~1500-byte moderation calls, and
    // a blocking submit that needs a dozen round trips stops feeling like posting.
    body: { type: String, required: true, maxlength: 5000 },
    imageUrl: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },

    status: { type: String, enum: ['visible', 'removed'], default: 'visible' },

    // What the moderator said about the text that WAS published. Kept for auditing a
    // complaint about something that got through.
    moderation: { type: mongoose.Schema.Types.Mixed, default: null },

    voteCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    isPinned: { type: Boolean, default: false },

    // Soft delete, so a removed post can be reviewed and the author told why.
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null },
    deleteReason: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

// Matches the listing query exactly: this community, visible, newest first by _id.
communityPostSchema.index({ community: 1, status: 1, _id: -1 });
communityPostSchema.index({ author: 1, _id: -1 });

module.exports = mongoose.model('CommunityPost', communityPostSchema);
