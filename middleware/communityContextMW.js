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

/**
 * Make sure the channel owner has an active 'owner' membership row in their community,
 * and return it.
 *
 * Self-repairing on purpose. The row used to be written once, right after the community,
 * in a separate write: a crash or a lost creation race between the two left a community
 * with no owner row, and a later Join by the owner created a plain 'member' row — after
 * which the owner was treated as a visitor in their own community forever. Calling this
 * whenever the owner touches their community fixes any of those states.
 */
async function ensureOwnerMembership(community) {
  const filter = { community: community._id, channel: community.channel };
  const existing = await CommunityMember.findOne(filter);

  if (existing && existing.role === 'owner' && existing.status === 'active') return existing;

  if (!existing) {
    try {
      const row = await CommunityMember.create({ ...filter, role: 'owner', status: 'active' });
      await Community.updateOne({ _id: community._id }, { $inc: { memberCount: 1 } });
      return row;
    } catch (err) {
      // A concurrent request created it first.
      if (err.code === 11000) return CommunityMember.findOne(filter);
      throw err;
    }
  }

  const wasActive = existing.status === 'active';
  existing.role = 'owner';
  existing.status = 'active';
  existing.bannedAt = null;
  existing.bannedBy = null;
  existing.banReason = '';
  await existing.save();
  if (!wasActive) {
    await Community.updateOne({ _id: community._id }, { $inc: { memberCount: 1 } });
  }
  return existing;
}

/** The community for a channel, created on first use, always with its owner row. */
async function ensureCommunity(channelId) {
  const existing = await Community.findOne({ channel: channelId });
  if (existing) {
    await ensureOwnerMembership(existing);
    return existing;
  }

  const channel = await Channel.findById(channelId).select('name description').lean();
  if (!channel) return null;

  let community;
  try {
    community = await Community.create({
      channel: channelId,
      name: `${channel.name} Community`,
      description: channel.description || '',
    });
  } catch (err) {
    // Two requests can race to create the same community; the unique index on `channel`
    // means the loser gets a duplicate-key error and should simply read the winner's row.
    if (err.code !== 11000) throw err;
    community = await Community.findOne({ channel: channelId });
  }

  await ensureOwnerMembership(community);
  return community;
}

/** Does `channelId` own this community? Read from the community, never from a row. */
const ownsCommunity = (community, channelId) =>
  Boolean(channelId) && String(community.channel) === String(channelId);

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

    const ctx = await contextFor(community, req.channelId);
    req.community = community;
    req.membership = ctx.membership;
    req.can = ctx.can;
    return next();
  } catch (err) {
    return next(err);
  }
};

/** Membership and abilities of `channelId` in an already-loaded community. */
async function contextFor(community, channelId) {
  const isOwner = ownsCommunity(community, channelId);
  const [membership, subscribed] = await Promise.all([
    isOwner
      ? ensureOwnerMembership(community)
      : channelId
        ? CommunityMember.findOne({ community: community._id, channel: channelId })
        : null,
    isSubscribedTo(community.channel, channelId),
  ]);
  return { membership, can: abilities(membership, community, subscribed, isOwner) };
}

/**
 * Same as loadCommunityContext, for routes addressed by a post or comment rather than a
 * channel (comments, votes, delete, pin). These used to read the membership row alone,
 * which is how an owner without a row — or after unbanning themselves — was refused.
 */
async function contextForCommunityId(communityId, channelId) {
  const community = await Community.findById(communityId);
  if (!community) return null;
  return { community, ...(await contextFor(community, channelId)) };
}

module.exports = {
  loadCommunityContext,
  ensureCommunity,
  ensureOwnerMembership,
  isSubscribedTo,
  contextForCommunityId,
  ownsCommunity,
};
