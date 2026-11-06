const {
    abilities,
    canDelete,
    canEdit,
    EDIT_WINDOW_MS,
} = require('../../services/communityPermissions');

/**
 * The permission matrix.
 *
 * No database and no HTTP, so this is the fastest file in the suite and the one with the
 * highest value per line: every assertion here is a security property, and a mistake is
 * a hole rather than a bug.
 */

const OWNER_CH = 'ch-owner';
const MEMBER_CH = 'ch-member';
const OTHER_CH = 'ch-other';

const openCommunity = { isOpen: true };
const closedCommunity = { isOpen: false };

const owner = { role: 'owner', status: 'active', channel: OWNER_CH };
const member = { role: 'member', status: 'active', channel: MEMBER_CH };
const banned = { role: 'member', status: 'banned', channel: MEMBER_CH };
const left = { role: 'member', status: 'left', channel: MEMBER_CH };

describe('abilities', () => {
    describe('owner', () => {
        const a = abilities(owner, openCommunity, false);

        it('can post, vote and moderate', () => {
            expect(a.canPost).toBe(true);
            expect(a.canVote).toBe(true);
            expect(a.canModerate).toBe(true);
        });

        it('cannot leave its own community', () => {
            // Leaving would orphan it — there is no mechanism to transfer ownership.
            expect(a.canLeave).toBe(false);
        });

        it('can post in a closed community', () => {
            expect(abilities(owner, closedCommunity).canPost).toBe(false);
            // Closing stops everyone posting, the owner included; it is a pause, not a
            // private mode.
        });
    });

    describe('active member', () => {
        const a = abilities(member, openCommunity, true);

        it('can post and vote but not moderate', () => {
            expect(a.canPost).toBe(true);
            expect(a.canVote).toBe(true);
            expect(a.canModerate).toBe(false);
        });

        it('can leave', () => {
            expect(a.canLeave).toBe(true);
        });

        it('cannot join again', () => {
            expect(a.canJoin).toBe(false);
        });
    });

    describe('banned channel', () => {
        it('cannot post, vote or moderate', () => {
            const a = abilities(banned, openCommunity, true);
            expect(a.canPost).toBe(false);
            expect(a.canVote).toBe(false);
            expect(a.canModerate).toBe(false);
        });

        it('CANNOT rejoin even while subscribed', () => {
            // The whole point of persisting a banned row rather than deleting it.
            expect(abilities(banned, openCommunity, true).canJoin).toBe(false);
        });

        it('cannot rejoin after unsubscribing and resubscribing', () => {
            // Ban is checked before subscription. The other order would make
            // unsubscribe -> resubscribe a one-click ban evasion.
            expect(abilities(banned, openCommunity, false).canJoin).toBe(false);
            expect(abilities(banned, openCommunity, true).canJoin).toBe(false);
        });

        it('can still read an open community', () => {
            // Hiding it would make a ban indistinguishable from deletion.
            expect(abilities(banned, openCommunity, true).canView).toBe(true);
        });
    });

    describe('non-member', () => {
        it('can join only when subscribed', () => {
            expect(abilities(null, openCommunity, false).canJoin).toBe(false);
            expect(abilities(null, openCommunity, true).canJoin).toBe(true);
        });

        it('cannot post or vote', () => {
            const a = abilities(null, openCommunity, true);
            expect(a.canPost).toBe(false);
            expect(a.canVote).toBe(false);
        });

        it('can view an open community but not a closed one', () => {
            expect(abilities(null, openCommunity, true).canView).toBe(true);
            expect(abilities(null, closedCommunity, true).canView).toBe(false);
        });
    });

    describe('a channel that left', () => {
        it('may rejoin when still subscribed', () => {
            // 'left' is not 'banned' — leaving is reversible by design.
            expect(abilities(left, openCommunity, true).canJoin).toBe(true);
        });

        it('cannot post until it does', () => {
            expect(abilities(left, openCommunity, true).canPost).toBe(false);
        });
    });
});

describe('canDelete', () => {
    const postByMember = { author: MEMBER_CH };
    const postByOther = { author: OTHER_CH };

    it('lets the owner delete anyone\'s post', () => {
        expect(canDelete(owner, postByOther)).toBe(true);
        expect(canDelete(owner, postByMember)).toBe(true);
    });

    it('lets a member delete only their own', () => {
        expect(canDelete(member, postByMember)).toBe(true);
        expect(canDelete(member, postByOther)).toBe(false);
    });

    it('stops a banned channel deleting even its own', () => {
        expect(canDelete(banned, postByMember)).toBe(false);
    });

    it('stops a non-member deleting anything', () => {
        expect(canDelete(null, postByMember)).toBe(false);
    });
});

describe('canEdit', () => {
    const now = Date.now();
    const fresh = { author: MEMBER_CH, createdAt: new Date(now - 60_000) };
    const old = { author: MEMBER_CH, createdAt: new Date(now - EDIT_WINDOW_MS - 1000) };

    it('allows editing own content inside the window', () => {
        expect(canEdit(member, fresh, now)).toBe(true);
    });

    it('refuses once the window has passed', () => {
        expect(canEdit(member, old, now)).toBe(false);
    });

    it('refuses someone else\'s content, even for the owner', () => {
        // Deliberately narrower than delete. A deletion is visible; an owner silently
        // rewriting a member's words would not be.
        expect(canEdit(owner, { author: OTHER_CH, createdAt: new Date(now) }, now)).toBe(false);
    });

    it('refuses a banned channel', () => {
        expect(canEdit(banned, fresh, now)).toBe(false);
    });
});
