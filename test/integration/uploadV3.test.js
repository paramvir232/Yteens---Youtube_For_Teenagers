process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

jest.mock('../../config/cloudinary', () => require('../mocks/cloudinary'));
jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const request = require('supertest');

const app = require('../../app');
const Video = require('../../models/videoModel');
const UploadAttempt = require('../../models/uploadAttemptModel');
const { makeChannel } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');

const moderation = require('../mocks/moderationClients');
const cloud = require('../mocks/cloudinary');

/**
 * /api/v3/upload: the v2 contract with two image models.
 * The rule itself is unit-tested in test/unit/dualImageModeration.test.js; these tests
 * pin that the route uses it end to end, and that v2 does NOT.
 */

const FAKE_VIDEO = Buffer.from('not really an mp4');
const FRAME = 'https://res.cloudinary.com/demo/image/upload/f1.jpg';
const UNSAFE = { safe: false, nsfw_score: 0.95, violence_score: 0, reason: 'nsfw content detected' };

const upload = (seeded, { version = 'v3', asyncMode = false, thumbnail = false } = {}) => {
    const req = request(app)
        .post(`/api/${version}/upload${asyncMode ? '?mode=async' : ''}`)
        .field('title', 'A perfectly nice video')
        .field('description', 'Nothing untoward here')
        .field('tags', 'music')
        .attach('video', FAKE_VIDEO, 'clip.mp4')
        .set('Authorization', `Bearer ${signAccessToken(seeded.user._id)}`);
    if (thumbnail) req.attach('thumbnail', Buffer.from('jpg'), 'thumb.jpg');
    return req;
};

async function waitForJob(jobId, token, tries = 40) {
    for (let i = 0; i < tries; i += 1) {
        const res = await request(app)
            .get(`/api/v2/upload/jobs/${jobId}`)
            .set('Authorization', `Bearer ${token}`);
        if (['accepted', 'rejected', 'failed'].includes(res.body?.data?.status)) return res.body.data;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job never reached a terminal state');
}

beforeEach(() => {
    moderation.__resetModeration();
    cloud.__resetCloudinary();
});

describe('POST /api/v3/upload', () => {
    it('accepts a clean upload, each frame scored by both models one image at a time', async () => {
        const seeded = await makeChannel();
        await upload(seeded).expect(201);
        expect(await Video.countDocuments()).toBe(1);
        expect(moderation.moderateImage).toHaveBeenCalledWith(FRAME);
        expect(moderation.moderateImageB).toHaveBeenCalledWith(FRAME);
        expect(moderation.moderateImagesB).not.toHaveBeenCalled();
    });

    it('accepts a video whose frame only model A flags (either model safe => safe)', async () => {
        const seeded = await makeChannel();
        moderation.__setImageVerdict(FRAME, UNSAFE);
        await upload(seeded).expect(201);
    });

    it('rejects at "frames" when BOTH models flag a frame, and cleans up', async () => {
        const seeded = await makeChannel();
        moderation.__setImageVerdict(FRAME, UNSAFE);
        moderation.__setImageBVerdict(FRAME, UNSAFE);

        const res = await upload(seeded).expect(400);
        expect(res.body.stage).toBe('frames');
        expect(res.body.detail).toMatch(/1 of 1 frames flagged/);
        expect(await Video.countDocuments()).toBe(0);
        expect((await UploadAttempt.findOne().lean()).stage).toBe('frames');
        expect(cloud.__destroyed.map((d) => d.publicId)).toContain('yteens_videos/test-video');
    });

    it('rejects at "thumbnail" only when both models flag it', async () => {
        const seeded = await makeChannel();
        moderation.__setVerdicts({ image: UNSAFE }); // A flags everything...
        await upload(seeded, { thumbnail: true }).expect(201); // ...B does not: published

        moderation.__setImageBVerdict(null, UNSAFE); // now B agrees
        const res = await upload(seeded, { thumbnail: true }).expect(400);
        expect(res.body.stage).toBe('thumbnail');
    });

    it('reports "unavailable" when model A flags a frame and model B is down', async () => {
        const seeded = await makeChannel();
        moderation.__setImageVerdict(FRAME, UNSAFE);
        moderation.__setImageBVerdict(null, new Error('model B cold-starting'));
        const res = await upload(seeded).expect(400);
        expect(res.body.stage).toBe('unavailable');
        expect(await Video.countDocuments()).toBe(0);
    });

    it('async mode: 202, then the job reaches rejected via the two-model rule', async () => {
        const seeded = await makeChannel();
        moderation.__setImageVerdict(FRAME, UNSAFE);
        moderation.__setImageBVerdict(FRAME, UNSAFE);

        const res = await upload(seeded, { asyncMode: true }).expect(202);
        expect(res.body.data.statusUrl).toBe(`/api/v2/upload/jobs/${res.body.data.jobId}`);
        const job = await waitForJob(res.body.data.jobId, signAccessToken(seeded.user._id));
        expect(job.status).toBe('rejected');
        expect(job.stage).toBe('frames');
    });

    it('requires a token, like v2', async () => {
        await request(app)
            .post('/api/v3/upload')
            .field('title', 'x')
            .attach('video', FAKE_VIDEO, 'clip.mp4')
            .expect(401);
    });
});

describe('/api/v2/upload is unchanged: one model, never model B', () => {
    it('does not call model B', async () => {
        const seeded = await makeChannel();
        await upload(seeded, { version: 'v2' }).expect(201);
        expect(moderation.moderateImagesB).not.toHaveBeenCalled();
        expect(moderation.moderateImageB).not.toHaveBeenCalled();
    });
});
