/**
 * The channel owner in their own community.
 *
 * The owner used to be recognised only through a CommunityMember row with role 'owner',
 * written once when the community was created. A missing, demoted or 'left' row turned
 * the owner into a visitor who was told to subscribe to their own channel; comments and
 * votes did not consider the owner at all. Ownership now comes from the community itself.
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const request = require('supertest');

const app = require('../../app');
const Channel = require('../../models/channelModel');
const Community = require('../../models/communityModel');
const CommunityMember = require('../../models/communityMemberModel');
const CommunityPost = require('../../models/communityPostModel');
const { makeChannel, subscribe } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');
const moderation = require('../mocks/moderationClients');

async function actor() {
    const { channel, user } = await makeChannel();
    return { channel, user, token: signAccessToken(user._id) };
}
const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);
const base = (owner) => `/api/v2/communities/${owner.channel._id}`;

beforeEach(() => moderation.__resetModeration());

describe('the owner in their own community', () => {
    it('can post without ever opening the community or subscribing', async () => {
        const owner = await actor();

        const res = await auth(request(app).post(`${base(owner)}/posts`), owner.token)
            .send({ title: 'Welcome', body: 'Hello everyone' })
            .expect(201);

        expect(res.body.data.title).toBe('Welcome');
        const row = await CommunityMember.findOne({ channel: owner.channel._id }).lean();
        expect(row).toMatchObject({ role: 'owner', status: 'active' });
    });

    it('is recognised as owner even when the owner row is missing', async () => {
        const owner = await actor();
        await auth(request(app).get(base(owner)), owner.token).expect(200);
        await CommunityMember.deleteMany({ channel: owner.channel._id });

        const res = await auth(request(app).get(base(owner)), owner.token).expect(200);

        expect(res.body.data.viewer).toMatchObject({ isOwner: true, canPost: true, canModerate: true });
        // ...and the missing row is repaired, not just papered over.
        const row = await CommunityMember.findOne({ channel: owner.channel._id }).lean();
        expect(row).toMatchObject({ role: 'owner', status: 'active' });
    });

    it('repairs a row that was demoted to a plain member', async () => {
        const owner = await actor();
        await auth(request(app).get(base(owner)), owner.token).expect(200);
        await CommunityMember.updateOne(
            { channel: owner.channel._id },
            { $set: { role: 'member', status: 'left' } }
        );

        await auth(request(app).post(`${base(owner)}/join`), owner.token).expect(200);

        const row = await CommunityMember.findOne({ channel: owner.channel._id }).lean();
        expect(row).toMatchObject({ role: 'owner', status: 'active' });
        expect(await CommunityMember.countDocuments({ channel: owner.channel._id })).toBe(1);
    });

    it('can comment and vote on posts, including a member\'s', async () => {
        const owner = await actor();
        const fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`${base(owner)}/join`), fan.token).expect(201);
        const post = await auth(request(app).post(`${base(owner)}/posts`), fan.token)
            .send({ title: 'Q', body: 'A question' })
            .expect(201);
        const postId = post.body.data._id;

        // Simulate the old broken state: the owner row is gone.
        await CommunityMember.deleteMany({ channel: owner.channel._id });

        await auth(request(app).post(`/api/v2/communities/posts/${postId}/comments`), owner.token)
            .send({ body: 'Good question' })
            .expect(201);
        await auth(request(app).post(`/api/v2/communities/posts/${postId}/vote`), owner.token)
            .send({ value: 1 })
            .expect(200);
        await auth(request(app).post(`/api/v2/communities/posts/${postId}/pin`), owner.token)
            .send({ pinned: true })
            .expect(200);
    });

    it('cannot unban themselves (it used to break their own commenting)', async () => {
        const owner = await actor();
        await auth(request(app).get(base(owner)), owner.token).expect(200);

        const res = await auth(
            request(app).post(`${base(owner)}/members/${owner.channel._id}/unban`),
            owner.token
        ).expect(400);

        expect(res.body.error.code).toBe('CANNOT_UNBAN_SELF');
        const row = await CommunityMember.findOne({ channel: owner.channel._id }).lean();
        expect(row.status).toBe('active');
    });

    it('cannot leave their own community', async () => {
        const owner = await actor();
        await auth(request(app).get(base(owner)), owner.token).expect(200);
        await auth(request(app).post(`${base(owner)}/leave`), owner.token).expect(403);
    });

    it('is told the community is closed rather than to join, when commenting there', async () => {
        const owner = await actor();
        const post = await auth(request(app).post(`${base(owner)}/posts`), owner.token)
            .send({ title: 'T', body: 'B' })
            .expect(201);
        await Community.updateOne({ channel: owner.channel._id }, { $set: { isOpen: false } });

        const res = await auth(
            request(app).post(`/api/v2/communities/posts/${post.body.data._id}/comments`),
            owner.token
        ).send({ body: 'later' }).expect(403);
        expect(res.body.error.code).toBe('COMMUNITY_CLOSED');
    });
});

describe('members are unchanged', () => {
    it('a non-member still cannot comment or vote', async () => {
        const owner = await actor();
        const stranger = await actor();
        const post = await auth(request(app).post(`${base(owner)}/posts`), owner.token)
            .send({ title: 'T', body: 'B' })
            .expect(201);
        const id = post.body.data._id;

        await auth(request(app).post(`/api/v2/communities/posts/${id}/comments`), stranger.token)
            .send({ body: 'hi' })
            .expect(403);
        await auth(request(app).post(`/api/v2/communities/posts/${id}/vote`), stranger.token)
            .send({ value: 1 })
            .expect(403);
    });

    it('a member cannot pin', async () => {
        const owner = await actor();
        const fan = await actor();
        await subscribe(owner.channel, fan.channel);
        await auth(request(app).post(`${base(owner)}/join`), fan.token).expect(201);
        const post = await CommunityPost.create({
            community: (await Community.findOne({ channel: owner.channel._id }))._id,
            author: fan.channel._id,
            title: 'T',
            body: 'B',
        });
        await auth(request(app).post(`/api/v2/communities/posts/${post._id}/pin`), fan.token)
            .send({ pinned: true })
            .expect(403);
    });
});

describe('subscribing to your own channel', () => {
    it('is refused, and does not change the subscriber count', async () => {
        const owner = await actor();

        await auth(request(app).post(`/channel/subscribe/${owner.channel._id}`), owner.token)
            .expect(400);

        const ch = await Channel.findById(owner.channel._id).lean();
        expect(ch.subscribers.count).toBe(0);
        expect(ch.subscribed || []).toHaveLength(0);
    });

    it('unsubscribing from yourself is refused too', async () => {
        const owner = await actor();
        await auth(request(app).post(`/channel/unsubscribe/${owner.channel._id}`), owner.token)
            .expect(400);
    });
});
