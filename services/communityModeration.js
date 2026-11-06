const { moderateImage } = require('./moderationClients');
const { isImageUnsafe } = require('./imageModeration');
const { moderateLongText } = require('./textModeration');
const CommunityModerationLog = require('../models/communityModerationLogModel');

/**
 * Moderating a post or comment before it is published.
 *
 * Reuses moderationClients and textModeration rather than talking to the services
 * directly — those modules are the single boundary to the outside world, which is what
 * makes the whole test suite able to guarantee it never spends real quota.
 *
 * ── Blocking, not optimistic ─────────────────────────────────────────────────
 * The content is checked before the insert, so a rejected post never exists in
 * communityPosts and is never visible to anyone, even briefly. The poster waits a
 * couple of seconds. On a platform for 10-20 year olds, "visible for three seconds then
 * retracted" is not a meaningfully different outcome from "visible".
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 * If a moderation service throws — down, cold-starting, rate-limited — nothing is
 * published and the caller gets a retryable error. The alternative, publishing when the
 * check cannot run, means an outage is an open door.
 *
 * The cost is real and worth stating: community posting stops working whenever those
 * two free-tier Spaces are unavailable, and a cold start there has been measured at
 * over a minute. That is the trade, chosen deliberately.
 */

class ModerationUnavailable extends Error {
  constructor(cause) {
    super('Content checks are temporarily unavailable.');
    this.code = 'MODERATION_UNAVAILABLE';
    this.statusCode = 503;
    this.cause = cause;
  }
}

/**
 * @returns {{safe: true}} or {{safe: false, stage, reason, scores}}
 * @throws  {ModerationUnavailable} when a check could not be run at all
 */
async function moderateContent({ body, imageUrl }) {
  let textVerdict;
  try {
    textVerdict = await moderateLongText(body || '');
  } catch (err) {
    throw new ModerationUnavailable(err);
  }

  if (!textVerdict.safe) {
    return { safe: false, stage: 'text', reason: 'text', scores: textVerdict.scores };
  }

  // Text first, image second: text is one cheap call and rejects most of what gets
  // rejected, so an unsafe post usually costs nothing further.
  if (imageUrl) {
    let imageVerdict;
    try {
      imageVerdict = await moderateImage(imageUrl);
    } catch (err) {
      throw new ModerationUnavailable(err);
    }

    // A post image is one image, so this stays a single-image decision - but on the same
    // bar as the thumbnail and video frames (services/imageModeration.js). Trusting the
    // service's own `safe` flag here would hold community posts to a ~0.3 threshold with
    // an 0.181 false-positive rate while everything else used 0.7.
    if (isImageUnsafe(imageVerdict)) {
      return {
        safe: false,
        stage: 'image',
        reason: imageVerdict.reason || 'image',
        scores: {
          nsfw_score: imageVerdict.nsfw_score,
          violence_score: imageVerdict.violence_score,
        },
      };
    }
    return { safe: true, text: textVerdict, image: imageVerdict };
  }

  return { safe: true, text: textVerdict, image: null };
}

/**
 * Record a rejection. Best-effort: a failed log must not change the outcome.
 *
 * Without this row a rejected submission vanishes completely — it never reaches
 * communityPosts — so "my post was wrongly blocked" would have nothing to review.
 */
async function logRejection({ community, author, kind, parentRef, body, imageUrl, verdict }) {
  try {
    await CommunityModerationLog.create({
      community,
      author,
      kind,
      parentRef: parentRef || null,
      body: body || '',
      imageUrl: imageUrl || '',
      stage: verdict.stage,
      reason: verdict.reason,
      scores: verdict.scores ?? null,
    });
  } catch (err) {
    console.error('[community] could not record a moderation rejection:', err.message);
  }
}

module.exports = { moderateContent, logRejection, ModerationUnavailable };
