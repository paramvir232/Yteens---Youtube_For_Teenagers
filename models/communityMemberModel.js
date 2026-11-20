const mongoose = require('mongoose');

/**
 * One channel's membership of one community.
 *
 * ── The unique index is the concurrency story ────────────────────────────────
 * A double-tapped Join button sends two requests. Without the unique index on
 * {community, channel} both would pass a "are you already a member?" check before
 * either wrote, and the community would end up with two rows for one channel and a
 * memberCount of 2. With it, the second insert is a duplicate-key error the handler
 * treats as "already joined" — which is also the correct answer.
 *
 * ── Why `left` is a status rather than a deletion ────────────────────────────
 * Leaving could delete the row, but then a ban would be erased by leaving and
 * re-joining. Keeping the row means ban state survives, which is what makes unsubscribe
 * -> resubscribe useless as a ban-evasion trick.
 */
const communityMemberSchema = new mongoose.Schema(
  {
    community: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Community',
      required: true,
    },
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },

    role: { type: String, enum: ['owner', 'member'], default: 'member' },
    status: { type: String, enum: ['active', 'banned', 'left'], default: 'active' },

    bannedAt: { type: Date, default: null },
    bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null },
    banReason: { type: String, default: '', maxlength: 300 },

    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

communityMemberSchema.index({ community: 1, channel: 1 }, { unique: true });
communityMemberSchema.index({ community: 1, status: 1 });

module.exports = mongoose.model('CommunityMember', communityMemberSchema);
