const express = require('express');
const rateLimit = require('express-rate-limit');
const { devDefault, numberFromEnv } = require('../config/devDefaults');

const Community = require('../models/communityModel');
const CommunityMember = require('../models/communityMemberModel');
const CommunityPost = require('../models/communityPostModel');
const CommunityComment = require('../models/communityCommentModel');
const CommunityVote = require('../models/communityVoteModel');

const catchAsync = require('../util/catchError');
const ApiError = require('../util/apiError');
const { encodeCursor, decodeCursor } = require('../util/cursor');
const { requireAuth, optionalAuth, resolveChannel } = require('../middleware/authMW');
const { loadCommunityContext } = require('../middleware/communityContextMW');
const { canDelete } = require('../services/communityPermissions');
const {
  moderateContent,
  logRejection,
  ModerationUnavailable,
} = require('../services/communityModeration');

const router = express.Router();

/**
 * Channel communities, mounted at /api/v2/communities.
 *
 * All new routes, so requiring a token for writes breaks nothing. Reads use optionalAuth
 * so a signed-out visitor can look at an open community.
 *
 * Every write is rate-limited: each one costs at least one call to a moderation service
 * on a free tier, so an unthrottled loop would exhaust the quota for every other user
 * of the platform.
 */

// The ceiling is env-driven so the test suite can raise it. The suite makes far more
// than 30 writes from one address, and a limiter that silently turns later requests
// into 429s produces failures that look like broken permissions rather than throttling.
// It is still a real limiter in every other environment, and there is a test that
// proves it rejects once the limit is reached.
const WRITE_LIMIT = numberFromEnv(
  'COMMUNITY_WRITE_LIMIT',
  Number(devDefault('COMMUNITY_WRITE_LIMIT', '100000') || 30)
);

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: WRITE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'You are posting too quickly. Try again shortly.' },
  },
});

const MAX_DEPTH = 3;

/** Cursor pagination over an _id-sorted collection, as used by the feed. */
async function paginate(Model, filter, { cursor, limit, sort = -1, select, populate }) {
  let cursorId;
  try {
    cursorId = decodeCursor(cursor);
  } catch {
    throw ApiError.badRequest('BAD_CURSOR', 'The cursor is not valid.');
  }

  const query = { ...filter };
  if (cursorId) query._id = sort === -1 ? { $lt: cursorId } : { $gt: cursorId };

  let find = Model.find(query).sort({ _id: sort }).limit(limit + 1);
  if (select) find = find.select(select);
  if (populate) find = find.populate(...populate);

  const rows = await find.lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    data: page,
    meta: {
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]._id) : null,
      hasMore,
      limit,
    },
  };
}

const clampLimit = (value, fallback = 20, max = 50) =>
  Math.min(Math.max(Number(value) || fallback, 1), max);

/** The caller's own view of a community, so the UI never has to infer permissions. */
const viewerBlock = (req) => ({
  isOwner: req.can.isOwner,
  isMember: req.can.isMember,
  isBanned: req.can.isBanned,
  isSubscribed: req.can.isSubscribed,
  canPost: req.can.canPost,
  canJoin: req.can.canJoin,
  canModerate: req.can.canModerate,
});

// ── The community itself ───────────────────────────────────────────────────────

/**
 * GET /:channelId — metadata plus the caller's own standing.
 *
 * `viewer` is computed server-side on purpose. Working out "am I the owner?" in the
 * client means comparing ids it was handed, which is both duplicated logic and
 * trivially wrong the moment the shapes change.
 */
router.get(
  '/:channelId',
  optionalAuth,
  resolveChannel(),
  loadCommunityContext({ create: true }),
  catchAsync(async (req, res) => {
    if (!req.can.canView) {
      throw new ApiError(403, 'COMMUNITY_CLOSED', 'This community is closed.');
    }
    res.status(200).json({
      data: {
        id: String(req.community._id),
        channel: String(req.community.channel),
        name: req.community.name,
        description: req.community.description,
        rules: req.community.rules,
        isOpen: req.community.isOpen,
        memberCount: req.community.memberCount,
        postCount: req.community.postCount,
        viewer: viewerBlock(req),
      },
    });
  })
);

/** PATCH /:channelId — owner edits the community's settings. */
router.patch(
  '/:channelId',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext({ create: true }),
  catchAsync(async (req, res) => {
    if (!req.can.canModerate) {
      throw new ApiError(403, 'NOT_OWNER', 'Only the channel owner can change this.');
    }

    const { name, description, rules, isOpen } = req.body || {};
    const updates = {};
    if (typeof name === 'string') updates.name = name.slice(0, 60);
    if (typeof description === 'string') updates.description = description.slice(0, 500);
    if (typeof rules === 'string') updates.rules = rules.slice(0, 2000);
    if (typeof isOpen === 'boolean') updates.isOpen = isOpen;

    await Community.updateOne({ _id: req.community._id }, { $set: updates });
    res.status(200).json({ data: { ...req.community.toObject(), ...updates } });
  })
);

// ── Membership ─────────────────────────────────────────────────────────────────

/**
 * POST /:channelId/join
 *
 * The subscription gate lives HERE, not in the client. A client-side check is a hint;
 * this is the rule.
 */
router.post(
  '/:channelId/join',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext({ create: true }),
  writeLimiter,
  catchAsync(async (req, res) => {
    if (req.can.isBanned) {
      // Checked before subscription: the other order lets a banned member unsubscribe
      // and resubscribe to clear the block.
      throw new ApiError(403, 'BANNED', 'You cannot join this community.');
    }
    if (req.can.isMember || req.can.isOwner) {
      return res.status(200).json({ data: { joined: true, alreadyMember: true } });
    }
    if (!req.can.isSubscribed) {
      throw new ApiError(403, 'NOT_SUBSCRIBED', 'Subscribe to this channel to join its community.');
    }

    try {
      const existing = await CommunityMember.findOne({
        community: req.community._id,
        channel: req.channelId,
      });

      if (existing) {
        // Rejoining after leaving. The row is reused so any ban history stays attached.
        existing.status = 'active';
        existing.joinedAt = new Date();
        await existing.save();
      } else {
        await CommunityMember.create({
          community: req.community._id,
          channel: req.channelId,
          role: 'member',
          status: 'active',
        });
      }

      await Community.updateOne({ _id: req.community._id }, { $inc: { memberCount: 1 } });
      res.status(201).json({ data: { joined: true } });
    } catch (err) {
      // The unique {community, channel} index turns a double-tapped Join into this,
      // which is simply "already a member".
      if (err.code === 11000) {
        return res.status(200).json({ data: { joined: true, alreadyMember: true } });
      }
      throw err;
    }
  })
);

router.post(
  '/:channelId/leave',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext(),
  catchAsync(async (req, res) => {
    if (req.can.isOwner) {
      // There is no ownership transfer, so leaving would orphan the community.
      throw new ApiError(403, 'OWNER_CANNOT_LEAVE', 'You cannot leave your own community.');
    }
    if (!req.can.isMember) {
      return res.status(200).json({ data: { left: true } });
    }

    // 'left', not deleted: keeping the row is what makes ban state survive a
    // leave-and-rejoin.
    await CommunityMember.updateOne(
      { community: req.community._id, channel: req.channelId },
      { $set: { status: 'left' } }
    );
    await Community.updateOne({ _id: req.community._id }, { $inc: { memberCount: -1 } });

    res.status(200).json({ data: { left: true } });
  })
);

/** GET /:channelId/members — owner only; the text and identities are not public. */
router.get(
  '/:channelId/members',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext(),
  catchAsync(async (req, res) => {
    if (!req.can.canModerate) {
      throw new ApiError(403, 'NOT_OWNER', 'Only the channel owner can see the member list.');
    }

    const result = await paginate(
      CommunityMember,
      { community: req.community._id },
      {
        cursor: req.query.cursor,
        limit: clampLimit(req.query.limit),
        populate: ['channel', 'name profileImage'],
      }
    );
    res.status(200).json(result);
  })
);

// ── Banning ────────────────────────────────────────────────────────────────────

/**
 * POST /:channelId/members/:memberChannelId/ban
 *
 * Writes `status: 'banned'` on the membership row and NOTHING ELSE. In particular it
 * never touches channelModel: the banned channel stays subscribed, so the owner's
 * subscriber count does not silently drop and the banned user keeps seeing the
 * channel's videos. A community ban is not an unsubscribe.
 *
 * `purge` is opt-in. Removing someone's existing posts is a separate decision from
 * stopping them making new ones, and doing it implicitly would delete content an owner
 * only wanted to stop adding to.
 */
router.post(
  '/:channelId/members/:memberChannelId/ban',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext(),
  catchAsync(async (req, res) => {
    if (!req.can.canModerate) {
      throw new ApiError(403, 'NOT_OWNER', 'Only the channel owner can ban members.');
    }

    const target = req.params.memberChannelId;
    if (String(target) === String(req.channelId)) {
      throw ApiError.badRequest('CANNOT_BAN_SELF', 'You cannot ban yourself.');
    }

    const membership = await CommunityMember.findOneAndUpdate(
      { community: req.community._id, channel: target },
      {
        $set: {
          status: 'banned',
          bannedAt: new Date(),
          bannedBy: req.channelId,
          banReason: String(req.body?.reason || '').slice(0, 300),
        },
      },
      // upsert: a channel can be banned pre-emptively, before it ever joins.
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    let purged = 0;
    if (req.body?.purge === true) {
      const result = await CommunityPost.updateMany(
        { community: req.community._id, author: target, status: 'visible' },
        { $set: { status: 'removed', deletedAt: new Date(), deletedBy: req.channelId } }
      );
      purged = result.modifiedCount || 0;
    }

    res.status(200).json({ data: { banned: true, purged, membership } });
  })
);

/**
 * POST /:channelId/members/:memberChannelId/unban
 *
 * Sets 'left', not 'active'. Lifting a ban restores the ability to rejoin; it does not
 * silently put someone back in a community they may no longer want to be in.
 */
router.post(
  '/:channelId/members/:memberChannelId/unban',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext(),
  catchAsync(async (req, res) => {
    if (!req.can.canModerate) {
      throw new ApiError(403, 'NOT_OWNER', 'Only the channel owner can unban members.');
    }

    await CommunityMember.updateOne(
      { community: req.community._id, channel: req.params.memberChannelId },
      { $set: { status: 'left', bannedAt: null, bannedBy: null, banReason: '' } }
    );

    res.status(200).json({ data: { unbanned: true } });
  })
);

// ── Posts ──────────────────────────────────────────────────────────────────────

router.get(
  '/:channelId/posts',
  optionalAuth,
  resolveChannel(),
  loadCommunityContext({ create: true }),
  catchAsync(async (req, res) => {
    if (!req.can.canView) {
      throw new ApiError(403, 'COMMUNITY_CLOSED', 'This community is closed.');
    }

    const result = await paginate(
      CommunityPost,
      { community: req.community._id, status: 'visible' },
      {
        cursor: req.query.cursor,
        limit: clampLimit(req.query.limit),
        // The raw moderation blob is for auditing, not for clients: returning it hands
        // anyone a tuning oracle for the thresholds.
        select: '-moderation',
        populate: ['author', 'name profileImage'],
      }
    );
    res.status(200).json(result);
  })
);

/**
 * POST /:channelId/posts — create, moderated before it is visible.
 *
 * 422 rather than 400 for a rejection: the request was well-formed, the content was not
 * acceptable. The stage is returned so the UI can say which part to change; the scores
 * are not.
 */
router.post(
  '/:channelId/posts',
  requireAuth,
  resolveChannel({ required: true }),
  loadCommunityContext({ create: true }),
  writeLimiter,
  catchAsync(async (req, res) => {
    if (req.can.isBanned) throw new ApiError(403, 'BANNED', 'You cannot post in this community.');
    if (!req.can.canPost) {
      throw new ApiError(403, 'NOT_MEMBER', 'Join this community to post in it.');
    }

    const { title = '', body, imageUrl = '' } = req.body || {};
    if (!body || !String(body).trim()) {
      throw ApiError.badRequest('BODY_REQUIRED', 'Write something before posting.');
    }

    let verdict;
    try {
      verdict = await moderateContent({ body, imageUrl });
    } catch (err) {
      if (err instanceof ModerationUnavailable) {
        // Fail closed. Nothing is published, and the client is told to retry rather
        // than being accused of posting something unsafe.
        throw new ApiError(503, err.code, err.message);
      }
      throw err;
    }

    if (!verdict.safe) {
      await logRejection({
        community: req.community._id,
        author: req.channelId,
        kind: 'post',
        body,
        imageUrl,
        verdict,
      });
      throw new ApiError(422, 'CONTENT_REJECTED', 'Your post was not published.', verdict.stage);
    }

    const post = await CommunityPost.create({
      community: req.community._id,
      author: req.channelId,
      title: String(title).slice(0, 200),
      body,
      imageUrl,
      moderation: { text: verdict.text?.scores ?? null, checkedAt: new Date() },
    });

    await Community.updateOne({ _id: req.community._id }, { $inc: { postCount: 1 } });

    res.status(201).json({ data: post });
  })
);

/** DELETE /posts/:postId — author or owner. Soft delete. */
router.delete(
  '/posts/:postId',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync(async (req, res) => {
    const post = await CommunityPost.findById(req.params.postId);
    if (!post || post.status === 'removed') {
      throw ApiError.notFound('POST_NOT_FOUND', 'That post could not be found.');
    }

    const membership = await CommunityMember.findOne({
      community: post.community,
      channel: req.channelId,
    });

    if (!canDelete(membership, post)) {
      throw new ApiError(403, 'NOT_ALLOWED', 'You cannot delete this post.');
    }

    post.status = 'removed';
    post.deletedAt = new Date();
    post.deletedBy = req.channelId;
    await post.save();

    await Community.updateOne({ _id: post.community }, { $inc: { postCount: -1 } });

    res.status(200).json({ data: { deleted: true } });
  })
);

/** POST /posts/:postId/pin — owner only. */
router.post(
  '/posts/:postId/pin',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync(async (req, res) => {
    const post = await CommunityPost.findById(req.params.postId);
    if (!post) throw ApiError.notFound('POST_NOT_FOUND', 'That post could not be found.');

    const membership = await CommunityMember.findOne({
      community: post.community,
      channel: req.channelId,
    });
    if (membership?.role !== 'owner') {
      throw new ApiError(403, 'NOT_OWNER', 'Only the channel owner can pin posts.');
    }

    post.isPinned = req.body?.pinned !== false;
    await post.save();
    res.status(200).json({ data: { isPinned: post.isPinned } });
  })
);

// ── Comments ───────────────────────────────────────────────────────────────────

router.get(
  '/posts/:postId/comments',
  optionalAuth,
  resolveChannel(),
  catchAsync(async (req, res) => {
    const post = await CommunityPost.findById(req.params.postId).lean();
    if (!post) throw ApiError.notFound('POST_NOT_FOUND', 'That post could not be found.');

    // Ascending: a thread reads oldest-first, unlike a feed.
    const result = await paginate(
      CommunityComment,
      { post: post._id, status: 'visible' },
      {
        cursor: req.query.cursor,
        limit: clampLimit(req.query.limit, 50),
        sort: 1,
        select: '-moderation',
        populate: ['author', 'name profileImage'],
      }
    );
    res.status(200).json(result);
  })
);

/**
 * POST /posts/:postId/comments — create a comment or a reply.
 *
 * `parentId` makes it a reply. Depth is capped: the UI renders one level of nesting,
 * and an unbounded chain makes building the tree unbounded work.
 */
router.post(
  '/posts/:postId/comments',
  requireAuth,
  resolveChannel({ required: true }),
  writeLimiter,
  catchAsync(async (req, res) => {
    const post = await CommunityPost.findById(req.params.postId).lean();
    if (!post || post.status === 'removed') {
      throw ApiError.notFound('POST_NOT_FOUND', 'That post could not be found.');
    }

    const membership = await CommunityMember.findOne({
      community: post.community,
      channel: req.channelId,
    });

    if (membership?.status === 'banned') {
      throw new ApiError(403, 'BANNED', 'You cannot comment in this community.');
    }
    if (!membership || !['active'].includes(membership.status)) {
      throw new ApiError(403, 'NOT_MEMBER', 'Join this community to comment.');
    }

    const { body, parentId } = req.body || {};
    if (!body || !String(body).trim()) {
      throw ApiError.badRequest('BODY_REQUIRED', 'Write something before posting.');
    }

    let depth = 0;
    if (parentId) {
      const parent = await CommunityComment.findById(parentId).lean();
      if (!parent || String(parent.post) !== String(post._id)) {
        throw ApiError.badRequest('BAD_PARENT', 'That comment is not on this post.');
      }
      depth = (parent.depth ?? 0) + 1;
      if (depth > MAX_DEPTH) {
        throw ApiError.badRequest('TOO_DEEP', 'You cannot reply any deeper in this thread.');
      }
    }

    let verdict;
    try {
      verdict = await moderateContent({ body });
    } catch (err) {
      if (err instanceof ModerationUnavailable) {
        throw new ApiError(503, err.code, err.message);
      }
      throw err;
    }

    if (!verdict.safe) {
      await logRejection({
        community: post.community,
        author: req.channelId,
        kind: 'comment',
        parentRef: post._id,
        body,
        verdict,
      });
      throw new ApiError(422, 'CONTENT_REJECTED', 'Your comment was not published.', verdict.stage);
    }

    const comment = await CommunityComment.create({
      post: post._id,
      community: post.community,
      author: req.channelId,
      parent: parentId || null,
      depth,
      body,
      moderation: { text: verdict.text?.scores ?? null, checkedAt: new Date() },
    });

    await CommunityPost.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } });

    res.status(201).json({ data: comment });
  })
);

router.delete(
  '/comments/:commentId',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync(async (req, res) => {
    const comment = await CommunityComment.findById(req.params.commentId);
    if (!comment || comment.status === 'removed') {
      throw ApiError.notFound('COMMENT_NOT_FOUND', 'That comment could not be found.');
    }

    const membership = await CommunityMember.findOne({
      community: comment.community,
      channel: req.channelId,
    });

    if (!canDelete(membership, comment)) {
      throw new ApiError(403, 'NOT_ALLOWED', 'You cannot delete this comment.');
    }

    comment.status = 'removed';
    comment.deletedAt = new Date();
    comment.deletedBy = req.channelId;
    await comment.save();

    await CommunityPost.updateOne({ _id: comment.post }, { $inc: { commentCount: -1 } });

    res.status(200).json({ data: { deleted: true } });
  })
);

// ── Votes ──────────────────────────────────────────────────────────────────────

/**
 * Vote on a post or comment. Sending the same direction again clears the vote, which is
 * what a tap on an already-active arrow should do.
 */
async function handleVote(req, res, Model, targetType) {
  const target = await Model.findById(req.params.id);
  if (!target || target.status === 'removed') {
    throw ApiError.notFound('NOT_FOUND', 'That item could not be found.');
  }

  const membership = await CommunityMember.findOne({
    community: target.community,
    channel: req.channelId,
  });
  if (membership?.status === 'banned') {
    throw new ApiError(403, 'BANNED', 'You cannot vote in this community.');
  }
  if (!membership || membership.status !== 'active') {
    throw new ApiError(403, 'NOT_MEMBER', 'Join this community to vote.');
  }

  const value = req.body?.value === -1 ? -1 : 1;
  const existing = await CommunityVote.findOne({ target: target._id, channel: req.channelId });

  let delta = 0;
  if (!existing) {
    await CommunityVote.create({
      target: target._id, targetType, channel: req.channelId, value,
    });
    delta = value;
  } else if (existing.value === value) {
    await CommunityVote.deleteOne({ _id: existing._id });
    delta = -value;
  } else {
    existing.value = value;
    await existing.save();
    delta = value * 2; // crossing from -1 to +1 moves the count by two
  }

  const updated = await Model.findByIdAndUpdate(
    target._id,
    { $inc: { voteCount: delta } },
    { new: true }
  ).lean();

  res.status(200).json({
    data: { voteCount: updated.voteCount, userVote: delta === -value ? 0 : value },
  });
}

router.post(
  '/posts/:id/vote',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync((req, res) => handleVote(req, res, CommunityPost, 'post'))
);

router.post(
  '/comments/:id/vote',
  requireAuth,
  resolveChannel({ required: true }),
  catchAsync((req, res) => handleVote(req, res, CommunityComment, 'comment'))
);

module.exports = router;
