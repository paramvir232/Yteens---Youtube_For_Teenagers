/**
 * Who may do what in a community.
 *
 * Pure functions over already-loaded documents — no database access, no Express. That
 * makes the entire permission matrix testable with no fixtures and no mongod, which
 * matters because this is the file where a mistake is a security hole rather than a
 * bug. It is also the file most likely to be read by someone asking "can a member
 * delete another member's post?", so the answer lives in one table.
 *
 *   action            owner   member(active)   banned   non-member
 *   view                yes        yes          yes*      yes*
 *   join                 -          -            NO        yes (if subscribed)
 *   leave                NO        yes           -          -
 *   create post/comment yes        yes           NO         NO
 *   edit own             yes        yes           NO         NO
 *   delete any           yes        NO           NO         NO
 *   delete own           yes        yes          NO         NO
 *   vote                 yes        yes           NO         NO
 *   ban / unban          yes        NO           NO         NO
 *   pin                  yes        NO           NO         NO
 *   edit settings        yes        NO           NO         NO
 *
 *   * reads are allowed while the community isOpen. A ban removes the ability to take
 *     part, not the ability to look — hiding the community would make a ban
 *     indistinguishable from the community being deleted.
 */

const EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * @param {object|null} membership  the actor's CommunityMember row, or null
 * @param {object} community        the Community document
 * @param {boolean} isSubscribed    is the actor's channel in the owner's subscribers?
 */
function abilities(membership, community, isSubscribed = false) {
  const status = membership?.status ?? null;
  const isOwner = membership?.role === 'owner';
  const isBanned = status === 'banned';
  const isActiveMember = status === 'active';

  return {
    isOwner,
    isBanned,
    isMember: isActiveMember,
    isSubscribed,

    canView: community?.isOpen !== false || isActiveMember || isOwner,

    // Ban is checked BEFORE subscription on purpose. Checking subscription first would
    // mean a banned member could unsubscribe and resubscribe to clear the block, which
    // is a one-click ban evasion.
    canJoin: !isBanned && !isActiveMember && !isOwner && isSubscribed,
    canLeave: isActiveMember && !isOwner,

    canPost: (isActiveMember || isOwner) && community?.isOpen !== false,
    canVote: isActiveMember || isOwner,

    canModerate: isOwner,   // delete anything, ban, pin, edit settings
  };
}

/** May this actor delete this post or comment? */
function canDelete(membership, content) {
  if (membership?.role === 'owner') return true;             // owner deletes anything
  if (membership?.status !== 'active') return false;         // banned or not a member
  return String(content.author) === String(membership.channel); // own content only
}

/**
 * May this actor edit it?
 *
 * Narrower than delete: own content only, even for the owner, and only within a short
 * window. An owner silently rewriting someone else's words would be worse than deleting
 * them — a deletion is visible, an edit is not.
 */
function canEdit(membership, content, now = Date.now()) {
  if (membership?.status !== 'active' && membership?.role !== 'owner') return false;
  if (String(content.author) !== String(membership.channel)) return false;
  const age = now - new Date(content.createdAt).getTime();
  return age <= EDIT_WINDOW_MS;
}

module.exports = { abilities, canDelete, canEdit, EDIT_WINDOW_MS };
