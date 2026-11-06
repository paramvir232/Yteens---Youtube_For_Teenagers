const Channel = require('../models/channelModel');
const Community = require('../models/communityModel');
const CommunityMember = require('../models/communityMemberModel');
const { abilities } = require('../services/communityPermissions');

/**
 * Load everything a community route needs to decide what the caller may do.
 *
 * Attaches req.community, req.membership and req.can, so each handler is a permission
 * check and the work itself rather than four lookups repeated verbatim. One place to
 * audit, and one place where an N+1 would otherwise creep in.
 *
 * Runs after requireAuth + resolveChannel, so req.channelId is the caller's channel.
 */

/** The community for a channel, created on first use. */
async function ensureCommunity(channelId) {
  const existing = await Community.findOne({ channel: channelId });
  if (existing) return existing;

  const channel = await Channel.findById(channelId).select('name description').lean();
  if (!channel) return null;

  try {
    const community = await Community.create({
      channel: channelId,
      name: `${channel.name} Community`,
      description: channel.description || '',
    });

    // The owner is a member from the start, so every later check can just read the
    // membership row rather than special-casing "is this the channel owner?".
    await CommunityMember.create({
      community: community._id,
      channel: channelId,
      role: 'owner',
      status: 'active',
    });
    await Community.updateOne({ _id: community._id }, { $inc: { memberCount: 1 } });

    return community;
  } catch (err) {
    // Two requests can race to create the same community; the unique index on `channel`
    // means the loser gets a duplicate-key error and should simply read the winner's row.
    if (err.code === 11000) return Community.findOne({ channel: channelId });
    throw err;
  }
}

/**
 * Is `subscriberChannelId` subscribed to `ownerChannelId`?
 *
 * Read-only, and the only point where this feature touches channelModel at all. A ban
 * must never alter subscriber data — a community ban is not an unsubscribe.
 *
 * Worth noting for later: subscribers.channels is an unbounded array in one document,
 * so for a very popular channel this read pulls the whole list. Fine at current scale;
 * it would need an index or a separate collection well before that becomes a problem.
 */
async function isSubscribedTo(ownerChannelId, subscriberChannelId) {
  if (!subscriberChannelId) return false;
  if (String(ownerChannelId) === String(subscriberChannelId)) return true; // own channel

  const owner = await Channel.findById(ownerChannelId)
    .select('subscribers.channels')
    .lean();
  if (!owner) return false;

  return (owner.subscribers?.channels || []).some(
    (id) => String(id) === String(subscriberChannelId)
  );
}

/**
 * @param {object} opts
 * @param {boolean} opts.create  create the community if it does not exist yet
 */
const loadCommunityContext = ({ create = false } = {}) => async (req, res, next) => {
  try {
    const channelId = req.params.channelId || req.body?.channelId;
    if (!channelId) {
      return res.status(400).json({
        error: { code: 'CHANNEL_REQUIRED', message: 'A channel is required.' },
      });
    }

    const community = create
      ? await ensureCommunity(channelId)
      : await Community.findOne({ channel: channelId });

    if (!community) {
      return res.status(404).json({
        error: { code: 'COMMUNITY_NOT_FOUND', message: 'That community does not exist.' },
      });
    }

    const [membership, subscribed] = await Promise.all([
      req.channelId
        ? CommunityMember.findOne({ community: community._id, channel: req.channelId })
        : null,
      isSubscribedTo(channelId, req.channelId),
    ]);

    req.community = community;
    req.membership = membership;
    req.can = abilities(membership, community, subscribed);
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { loadCommunityContext, ensureCommunity, isSubscribedTo };
