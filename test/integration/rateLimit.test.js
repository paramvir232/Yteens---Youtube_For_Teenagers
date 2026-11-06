process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

// Set BEFORE the route module is required: the limiter reads this once, at construction.
// The rest of the suite raises this ceiling so throttling does not interfere with tests
// about permissions — which means without this file nothing would prove the limiter
// works at all.
process.env.COMMUNITY_WRITE_LIMIT = '3';

jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const request = require('supertest');

const app = require('../../app');
const { makeChannel, subscribe } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');
const moderation = require('../mocks/moderationClients');

const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);

beforeEach(() => moderation.__resetModeration());

describe('community write rate limiting', () => {
    it('rejects once the ceiling is reached', async () => {
        const { channel: ownerChannel } = await makeChannel();
        const fan = await makeChannel();
        const token = signAccessToken(fan.user._id);
        await subscribe(ownerChannel, fan.channel);

        await auth(request(app).post(`/api/v2/communities/${ownerChannel._id}/join`), token);

        const statuses = [];
        for (let i = 0; i < 6; i += 1) {
            const res = await auth(
                request(app)
                    .post(`/api/v2/communities/${ownerChannel._id}/posts`)
                    .send({ body: `post ${i}` }),
                token
            );
            statuses.push(res.status);
        }

        // Every community write costs at least one call to a moderation service on a
        // free tier, so an unthrottled loop would exhaust the quota for every other
        // user of the platform.
        expect(statuses).toContain(429);
    });

    it('explains itself rather than failing opaquely', async () => {
        const { channel: ownerChannel } = await makeChannel();
        const fan = await makeChannel();
        const token = signAccessToken(fan.user._id);
        await subscribe(ownerChannel, fan.channel);

        let limited;
        for (let i = 0; i < 8; i += 1) {
            const res = await auth(
                request(app)
                    .post(`/api/v2/communities/${ownerChannel._id}/posts`)
                    .send({ body: `post ${i}` }),
                token
            );
            if (res.status === 429) { limited = res; break; }
        }

        expect(limited).toBeDefined();
        expect(limited.body.error.code).toBe('RATE_LIMITED');
        // standardHeaders: the client can tell how long to wait instead of guessing.
        expect(limited.headers['ratelimit-limit'] ?? limited.headers['ratelimit']).toBeDefined();
    });
});

describe('auth rate limiting', () => {
    it('throttles repeated login attempts', async () => {
        // Login runs bcrypt on every attempt, which is deliberately expensive. Without a
        // limit it is both a free CPU-exhaustion target and an unlimited password-guessing
        // oracle.
        const statuses = [];
        for (let i = 0; i < 25; i += 1) {
            const res = await request(app)
                .post('/api/v2/auth/login')
                .send({ email: 'nobody@example.com', password: 'guess' });
            statuses.push(res.status);
        }

        expect(statuses).toContain(429);
    });
});
