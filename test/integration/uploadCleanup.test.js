process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

jest.mock('../../config/cloudinary', () => require('../mocks/cloudinary'));
jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../../app');
const UploadJob = require('../../models/uploadJobModel');
const { makeChannel, makeUser } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');
const { optionalAuth } = require('../../middleware/authMW');

const moderation = require('../mocks/moderationClients');
const cloud = require('../mocks/cloudinary');

/**
 * Failed uploads must not leave files in Cloudinary.
 *
 * Multer stores both files in Cloudinary before the route runs. These tests pin that
 *  - a request that cannot succeed (no/expired/invalid token, no channel) is answered
 *    BEFORE anything is stored, and
 *  - any failure after storing deletes what was stored,
 * on all three upload routes. See middleware/uploadGuardMW.js.
 */

const ROUTES = ['/api/v2/upload', '/api/v3/upload', '/video/upload'];
const FAKE_VIDEO = Buffer.from('not really an mp4');

const post = (path, { bearer, thumbnail = true } = {}) => {
    const req = request(app)
        .post(path)
        .field('title', 'A perfectly nice video')
        .field('description', 'Nothing untoward here')
        .field('tags', 'music')
        .attach('video', FAKE_VIDEO, 'clip.mp4');
    if (thumbnail) req.attach('thumbnail', Buffer.from('jpg'), 'thumb.jpg');
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req;
};

const expiredToken = (userId) =>
    jwt.sign({ sub: String(userId), typ: 'access' }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });

/** Cleanup runs on 'finish', after the response is sent; give it a tick. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
    moderation.__resetModeration();
    cloud.__resetCloudinary();
    delete process.env.LEGACY_ACTOR_FALLBACK;
});

describe.each(ROUTES)('%s', (path) => {
    it('no token: 401 TOKEN_MISSING and nothing is stored in Cloudinary', async () => {
        const res = await post(path).expect(401);
        expect(res.body.error.code).toBe('TOKEN_MISSING');
        expect(cloud.__stored).toHaveLength(0);
    });

    it('expired token: 401 TOKEN_EXPIRED before the upload is stored', async () => {
        const { user } = await makeChannel();
        const res = await post(path, { bearer: expiredToken(user._id) }).expect(401);
        expect(res.body.error.code).toBe('TOKEN_EXPIRED');
        expect(cloud.__stored).toHaveLength(0);
    });

    it('invalid token: 401 TOKEN_INVALID before the upload is stored', async () => {
        const res = await post(path, { bearer: 'not-a-jwt' }).expect(401);
        expect(res.body.error.code).toBe('TOKEN_INVALID');
        expect(cloud.__stored).toHaveLength(0);
    });

    it('signed in without a channel: 403 NO_CHANNEL before the upload is stored', async () => {
        const user = await makeUser();
        const res = await post(path, { bearer: signAccessToken(user._id) }).expect(403);
        expect(res.body.error.code).toBe('NO_CHANNEL');
        expect(cloud.__stored).toHaveLength(0);
    });

    it('Cloudinary fails on the second file: the first one is deleted', async () => {
        const { user } = await makeChannel();
        cloud.__failField('thumbnail');
        await post(path, { bearer: signAccessToken(user._id) }).expect(500);
        await settle();
        expect(cloud.__stored).toEqual(['yteens_videos/test-video']);
        expect(cloud.__destroyed.map((d) => d.publicId)).toContain('yteens_videos/test-video');
    });

    it('a successful upload keeps its files', async () => {
        const { user } = await makeChannel();
        await post(path, { bearer: signAccessToken(user._id) }).expect(201);
        await settle();
        expect(cloud.__destroyed).toHaveLength(0);
    });
});

describe('failures inside a route after the files are stored', () => {
    it('/video/upload with only a thumbnail: 400, and the thumbnail is deleted', async () => {
        const { user } = await makeChannel();
        await request(app)
            .post('/video/upload')
            .field('title', 'A perfectly nice video')
            .field('description', 'Nothing untoward here')
            .field('tags', 'music')
            .attach('thumbnail', Buffer.from('jpg'), 'thumb.jpg')
            .set('Authorization', `Bearer ${signAccessToken(user._id)}`)
            .expect(400);
        await settle();
        expect(cloud.__destroyed.map((d) => d.publicId)).toContain('yteens_videos/test-thumb');
    });

    it('async upload (202) keeps the files for the background job', async () => {
        const { user } = await makeChannel();
        await post('/api/v3/upload?mode=async', { bearer: signAccessToken(user._id) }).expect(202);
        await settle();
        // The job itself is accepted (clean mocks), so nothing is ever destroyed.
        await new Promise((r) => setTimeout(r, 300));
        expect(cloud.__destroyed).toHaveLength(0);
    });
});

describe('LEGACY_ACTOR_FALLBACK=true (rollback switch)', () => {
    it('a no-token request is passed through to the route as before', async () => {
        process.env.LEGACY_ACTOR_FALLBACK = 'true';
        const { channel } = await makeChannel();
        await post('/video/upload').field('channelId', String(channel._id)).expect(201);
    });
});

describe('optionalAuth after the early check', () => {
    it('does not re-verify a token already verified before the upload', () => {
        const req = { auth: { userId: 'u1' }, headers: { authorization: 'Bearer expired-by-now' } };
        const res = { status: jest.fn(() => res), json: jest.fn() };
        const next = jest.fn();
        optionalAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });
});

describe('sweepStaleJobs', () => {
    it('deletes the files of a job abandoned by a dead process', async () => {
        const { channel } = await makeChannel();
        const { sweepStaleJobs } = require('../../services/uploadJobRunner');
        await UploadJob.create({
            channel: channel._id,
            status: 'running',
            heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
            videoPublicId: 'yteens_videos/orphan-video',
            thumbnailPublicId: 'yteens_videos/orphan-thumb',
        });
        expect(await sweepStaleJobs()).toBe(1);
        expect(cloud.__destroyed.map((d) => d.publicId)).toEqual(
            expect.arrayContaining(['yteens_videos/orphan-video', 'yteens_videos/orphan-thumb'])
        );
    });

    it('leaves a healthy job and its files alone', async () => {
        const { channel } = await makeChannel();
        const { sweepStaleJobs } = require('../../services/uploadJobRunner');
        await UploadJob.create({
            channel: channel._id, status: 'running', heartbeatAt: new Date(),
            videoPublicId: 'yteens_videos/live',
        });
        expect(await sweepStaleJobs()).toBe(0);
        expect(cloud.__destroyed).toHaveLength(0);
    });
});
