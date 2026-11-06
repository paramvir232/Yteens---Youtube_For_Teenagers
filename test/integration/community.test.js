process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const request = require('supertest');

const app = require('../../app');
const Channel = require('../../models/channelModel');
const Community = require('../../models/communityModel');
const CommunityMember = require('../../models/communityMemberModel');
const CommunityPost = require('../../models/communityPostModel');
const CommunityComment = require('../../models/communityCommentModel');
const CommunityModerationLog = require('../../models/communityModerationLogModel');
const { makeChannel, subscribe } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');
const moderation = require('../mocks/moderationClients');

/** A channel plus a token for its owner. */
async function actor() {
    const { channel, user } = await makeChannel();
    return { channel, user, token: signAccessToken(user._id) };
}

const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);

beforeEach(() => moderation.__resetModeration());

describe('joining a community', () => {
    it('refuses a channel that is not subscribed', async () => {
        const owner = await actor();
        const visitor = await actor();

        const res = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/join`),
            visitor.token
        ).expect(403);

        // The gate is server-side. A client-side check is a hint; this is the rule.
        expect(res.body.error.code).toBe('NOT_SUBSCRIBED');
        expect(await CommunityMember.countDocuments({ role: 'member' })).toBe(0);
    });

    it('lets a subscribed channel join', async () => {
        const owner = await actor();
        const fan = await actor();
        await subscribe(owner.channel, fan.channel);

        await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/join`),
            fan.token
        ).expect(201);

        const membership = await CommunityMember.findOne({ channel: fan.channel._id }).lean();
        expect(membership.status).toBe('active');
    });

    it('is idempotent when joined twice', async () => {
        const owner = await actor();
        const fan = await actor();
        await subscribe(owner.channel, fan.channel);

        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);
        const second = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/join`),
            fan.token
        ).expect(200);

        // A double-tapped Join must not produce two memberships or inflate memberCount.
        expect(second.body.data.alreadyMember).toBe(true);
        expect(await CommunityMember.countDocuments({ channel: fan.channel._id })).toBe(1);
    });

    it('makes the channel owner a member automatically', async () => {
        const owner = await actor();

        const res = await auth(
            request(app).get(`/api/v2/communities/${owner.channel._id}`),
            owner.token
        ).expect(200);

        expect(res.body.data.viewer.isOwner).toBe(true);
        expect(res.body.data.viewer.canPost).toBe(true);
    });
});

describe('banning', () => {
    let owner; let fan;

    beforeEach(async () => {
        owner = await actor();
        fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);
    });

    it('NEVER modifies the subscription document', async () => {
        // The hard constraint of this whole project, asserted directly: a community ban
        // is not an unsubscribe. The owner's subscriber count must not silently drop,
        // and the banned user keeps seeing the channel's videos.
        const before = await Channel.findById(owner.channel._id).lean();

        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            owner.token
        ).expect(200);

        const after = await Channel.findById(owner.channel._id).lean();
        expect(after).toEqual(before);
    });

    it('stops the banned channel posting', async () => {
        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            owner.token
        );

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'hello' }),
            fan.token
        ).expect(403);

        expect(res.body.error.code).toBe('BANNED');
    });

    it('survives unsubscribe and resubscribe', async () => {
        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            owner.token
        );

        // Simulate leaving and coming back. If subscription were checked before the
        // ban, this would be a one-click ban evasion.
        await Channel.updateOne(
            { _id: owner.channel._id },
            { $pull: { 'subscribers.channels': fan.channel._id } }
        );
        await subscribe(owner.channel, fan.channel);

        const res = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/join`),
            fan.token
        ).expect(403);

        expect(res.body.error.code).toBe('BANNED');
    });

    it('leaves existing posts alone unless purge is asked for', async () => {
        await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        ).expect(201);

        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            owner.token
        );

        // Stopping someone posting and deleting what they already wrote are separate
        // decisions; doing the second implicitly would destroy content.
        expect(await CommunityPost.countDocuments({ status: 'visible' })).toBe(1);
    });

    it('removes them when purge is asked for', async () => {
        await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        );

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`)
                .send({ purge: true }),
            owner.token
        ).expect(200);

        expect(res.body.data.purged).toBe(1);
        expect(await CommunityPost.countDocuments({ status: 'visible' })).toBe(0);
    });

    it('requires the channel owner', async () => {
        const res = await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            fan.token
        ).expect(403);
        expect(res.body.error.code).toBe('NOT_OWNER');
    });

    it('unban requires a deliberate rejoin rather than restoring membership', async () => {
        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/ban`
            ),
            owner.token
        );
        await auth(
            request(app).post(
                `/api/v2/communities/${owner.channel._id}/members/${fan.channel._id}/unban`
            ),
            owner.token
        ).expect(200);

        // 'left', not 'active': lifting a ban restores the ability to rejoin, it does
        // not silently put someone back in a community they may not want to be in.
        const membership = await CommunityMember.findOne({ channel: fan.channel._id }).lean();
        expect(membership.status).toBe('left');

        await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/join`),
            fan.token
        ).expect(201);
    });
});

describe('posting', () => {
    let owner; let fan;

    beforeEach(async () => {
        owner = await actor();
        fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);
    });

    it('publishes content that passes moderation', async () => {
        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ title: 'Hello', body: 'Something perfectly ordinary' }),
            fan.token
        ).expect(201);

        expect(res.body.data.body).toBe('Something perfectly ordinary');
        expect(await CommunityPost.countDocuments({ status: 'visible' })).toBe(1);
    });

    it('rejects unsafe text with 422 and publishes NOTHING', async () => {
        moderation.__setVerdicts({ text: { safe: false, scores: { toxicity: 0.97 } } });

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'something nasty' }),
            fan.token
        ).expect(422);

        // 422, not 400: the request was well-formed, the content was not acceptable.
        expect(res.body.error.code).toBe('CONTENT_REJECTED');
        expect(res.body.error.stage).toBe('text');

        // Blocking moderation means it is never visible, not even briefly.
        expect(await CommunityPost.countDocuments()).toBe(0);
    });

    it('records a rejection so it can be reviewed', async () => {
        moderation.__setVerdicts({ text: { safe: false, scores: { toxicity: 0.97 } } });

        await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'something nasty' }),
            fan.token
        ).expect(422);

        const log = await CommunityModerationLog.findOne().lean();
        expect(log.kind).toBe('post');
        expect(log.body).toBe('something nasty');
    });

    it('never returns the raw scores to the client', async () => {
        moderation.__setVerdicts({ text: { safe: false, scores: { toxicity: 0.97 } } });

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'nope' }),
            fan.token
        ).expect(422);

        // Returning them would hand anyone a tuning oracle for the thresholds.
        expect(JSON.stringify(res.body)).not.toContain('0.97');
        expect(JSON.stringify(res.body)).not.toContain('toxicity');
    });

    it('moderates an image only after the text passes', async () => {
        moderation.__setVerdicts({ text: { safe: false } });

        await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'bad', imageUrl: 'https://example.com/i.jpg' }),
            fan.token
        ).expect(422);

        // Text is one cheap call and rejects most of what gets rejected, so an unsafe
        // post usually costs nothing further.
        expect(moderation.moderateImage).not.toHaveBeenCalled();
    });

    it('rejects an unsafe image with stage "image"', async () => {
        moderation.__setVerdicts({
            image: { safe: false, nsfw_score: 0.9, violence_score: 0, reason: 'nsfw' },
        });

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'fine words', imageUrl: 'https://example.com/i.jpg' }),
            fan.token
        ).expect(422);

        expect(res.body.error.stage).toBe('image');
    });

    it('FAILS CLOSED with 503 when moderation is unavailable', async () => {
        moderation.__setVerdicts({ text: new Error('Space is cold-starting') });

        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'perfectly fine' }),
            fan.token
        ).expect(503);

        // Publishing when the check cannot run would make an outage an open door. The
        // cost is that posting stops when those free-tier services do.
        expect(res.body.error.code).toBe('MODERATION_UNAVAILABLE');
        expect(await CommunityPost.countDocuments()).toBe(0);
    });

    it('refuses a non-member', async () => {
        const stranger = await actor();
        const res = await auth(
            request(app)
                .post(`/api/v2/communities/${owner.channel._id}/posts`)
                .send({ body: 'hello' }),
            stranger.token
        ).expect(403);
        expect(res.body.error.code).toBe('NOT_MEMBER');
    });

    it('requires a token', async () => {
        await request(app)
            .post(`/api/v2/communities/${owner.channel._id}/posts`)
            .send({ body: 'hello' })
            .expect(401);
    });
});

describe('deleting', () => {
    let owner; let fan; let postId;

    beforeEach(async () => {
        owner = await actor();
        fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);

        const res = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        );
        postId = res.body.data._id;
    });

    it('lets the author delete their own post', async () => {
        await auth(request(app).delete(`/api/v2/communities/posts/${postId}`), fan.token).expect(200);
        expect(await CommunityPost.countDocuments({ status: 'visible' })).toBe(0);
    });

    it('lets the channel owner delete anyone\'s post', async () => {
        await auth(request(app).delete(`/api/v2/communities/posts/${postId}`), owner.token).expect(200);
    });

    it('stops a member deleting someone else\'s', async () => {
        const other = await actor();
        await subscribe(owner.channel, other.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), other.token);

        const res = await auth(
            request(app).delete(`/api/v2/communities/posts/${postId}`),
            other.token
        ).expect(403);
        expect(res.body.error.code).toBe('NOT_ALLOWED');
    });

    it('soft-deletes rather than destroying the row', async () => {
        await auth(request(app).delete(`/api/v2/communities/posts/${postId}`), fan.token);

        // Kept so a removal can be reviewed and the author told why.
        const post = await CommunityPost.findById(postId).lean();
        expect(post.status).toBe('removed');
        expect(post.deletedBy).not.toBeNull();
    });
});

describe('comments and replies', () => {
    let owner; let fan; let postId;

    beforeEach(async () => {
        owner = await actor();
        fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);

        const res = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        );
        postId = res.body.data._id;
    });

    const comment = (body, parentId, token = fan.token) =>
        auth(
            request(app).post(`/api/v2/communities/posts/${postId}/comments`).send({ body, parentId }),
            token
        );

    it('creates a top-level comment', async () => {
        const res = await comment('nice post').expect(201);
        expect(res.body.data.parent).toBeNull();
        expect(res.body.data.depth).toBe(0);
    });

    it('creates a reply with a parent reference', async () => {
        const parent = await comment('nice post').expect(201);
        const reply = await comment('thanks', parent.body.data._id).expect(201);

        expect(String(reply.body.data.parent)).toBe(String(parent.body.data._id));
        expect(reply.body.data.depth).toBe(1);
    });

    it('caps nesting depth', async () => {
        let parentId = null;
        for (let i = 0; i <= 3; i += 1) {
            const res = await comment(`level ${i}`, parentId).expect(201);
            parentId = res.body.data._id;
        }
        // The UI renders one level of nesting, and an unbounded chain makes building
        // the tree unbounded work.
        const tooDeep = await comment('too far', parentId).expect(400);
        expect(tooDeep.body.error.code).toBe('TOO_DEEP');
    });

    it('refuses a parent from a different post', async () => {
        const otherPost = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'two' }),
            fan.token
        );
        const foreign = await auth(
            request(app)
                .post(`/api/v2/communities/posts/${otherPost.body.data._id}/comments`)
                .send({ body: 'elsewhere' }),
            fan.token
        );

        const res = await comment('reply', foreign.body.data._id).expect(400);
        expect(res.body.error.code).toBe('BAD_PARENT');
    });

    it('moderates comments too', async () => {
        moderation.__setVerdicts({ text: { safe: false } });

        const res = await comment('something nasty').expect(422);

        expect(res.body.error.code).toBe('CONTENT_REJECTED');
        expect(await CommunityComment.countDocuments()).toBe(0);
    });

    it('keeps the post\'s comment count in step', async () => {
        await comment('one');
        await comment('two');

        const post = await CommunityPost.findById(postId).lean();
        expect(post.commentCount).toBe(2);
    });
});

describe('voting', () => {
    let owner; let fan; let postId;

    beforeEach(async () => {
        owner = await actor();
        fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);

        const res = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        );
        postId = res.body.data._id;
    });

    const vote = (value, token = fan.token) =>
        auth(request(app).post(`/api/v2/communities/posts/${postId}/vote`).send({ value }), token);

    it('counts an upvote', async () => {
        const res = await vote(1).expect(200);
        expect(res.body.data.voteCount).toBe(1);
    });

    it('clears the vote when the same direction is sent again', async () => {
        await vote(1);
        const res = await vote(1).expect(200);

        // Tapping an already-active arrow should undo it.
        expect(res.body.data.voteCount).toBe(0);
        expect(res.body.data.userVote).toBe(0);
    });

    it('moves by two when switching direction', async () => {
        await vote(1);
        const res = await vote(-1).expect(200);
        expect(res.body.data.voteCount).toBe(-1);
    });

    it('counts one vote per channel however many times it is sent', async () => {
        await vote(1);
        await vote(1);
        await vote(1);

        const post = await CommunityPost.findById(postId).lean();
        expect(Math.abs(post.voteCount)).toBeLessThanOrEqual(1);
    });

    it('refuses a non-member', async () => {
        const stranger = await actor();
        await vote(1, stranger.token).expect(403);
    });
});

describe('listing', () => {
    it('hides removed posts', async () => {
        const owner = await actor();
        const fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`/api/v2/communities/${owner.channel._id}/join`), fan.token);

        const post = await auth(
            request(app).post(`/api/v2/communities/${owner.channel._id}/posts`).send({ body: 'hi' }),
            fan.token
        );
        await auth(
            request(app).delete(`/api/v2/communities/posts/${post.body.data._id}`),
            fan.token
        );

        const res = await request(app)
            .get(`/api/v2/communities/${owner.channel._id}/posts`)
            .expect(200);

        expect(res.body.data).toHaveLength(0);
    });

    it('is readable without a token', async () => {
        const owner = await actor();
        const res = await request(app)
            .get(`/api/v2/communities/${owner.channel._id}`)
            .expect(200);

        expect(res.body.data.viewer.isMember).toBe(false);
        expect(res.body.data.viewer.canPost).toBe(false);
    });
});
