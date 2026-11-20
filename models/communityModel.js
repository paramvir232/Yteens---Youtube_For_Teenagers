const mongoose = require('mongoose');

/**
 * A channel's community. One per channel, created lazily on first use.
 *
 * ── Members are CHANNELS, not users ──────────────────────────────────────────
 * Subscription in this app is channel-to-channel: channelModel stores
 * `subscribers.channels` and `subscribed` as arrays of Channel ids, and
 * /channel/subscribe/:id takes a `subscriberId` that is a channel. Since joining
 * requires being subscribed, membership has to be expressed in the same terms or the
 * two could never be checked against each other.
 *
 * The consequence, which is worth stating plainly: creating a channel is a prerequisite
 * for taking part in any community. A user who has never made one has nothing to
 * subscribe with.
 *
 * Every collection in this feature is new. channelModel, usersModel and videoModel are
 * read but never written.
 */
const communitySchema = new mongoose.Schema(
  {
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
      unique: true,
    },

    name: { type: String, default: '', trim: true, maxlength: 60 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    rules: { type: String, default: '', maxlength: 2000 },

    // Lets an owner close a community without deleting it or its posts.
    isOpen: { type: Boolean, default: true },

    // Maintained with $inc rather than counted on read. Counting members or posts on
    // every page load is the kind of query that is free with ten rows and a problem
    // with ten thousand.
    memberCount: { type: Number, default: 0 },
    postCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Community', communitySchema);
