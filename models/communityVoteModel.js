const mongoose = require('mongoose');

/**
 * One channel's vote on one post or comment.
 *
 * A separate collection rather than an array on the post, deliberately. videos.likes.by
 * is an unbounded array of channel ids inside the video document, and it is precisely
 * why the old feed response was so heavy: every video shipped every liker to every
 * client. Repeating that here would make a popular post slow to read for everyone.
 *
 * The unique index on {target, channel} enforces one vote per channel per item, so a
 * double-tap is a duplicate-key error rather than two votes.
 */
const communityVoteSchema = new mongoose.Schema(
  {
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: ['post', 'comment'], required: true },
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },
    value: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true }
);

communityVoteSchema.index({ target: 1, channel: 1 }, { unique: true });

module.exports = mongoose.model('CommunityVote', communityVoteSchema);
