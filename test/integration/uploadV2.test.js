process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

// Hoisted above every require below, which is what makes the Cloudinary mock work at
// all: config/cloudinary.js builds its multer storage engine at require time.
jest.mock('../../config/cloudinary', () => require('../mocks/cloudinary'));
jest.mock('../../services/moderationClients', () => require('../mocks/moderationClients'));

const request = require('supertest');

const app = require('../../app');
const Video = require('../../models/videoModel');
const Transcript = require('../../models/transcriptModel');
const UploadAttempt = require('../../models/uploadAttemptModel');
const UploadJob = require('../../models/uploadJobModel');
const Channel = require('../../models/channelModel');
const { makeChannel } = require('../helpers/seed');

const moderation = require('../mocks/moderationClients');
const cloud = require('../mocks/cloudinary');

const FAKE_VIDEO = Buffer.from('not really an mp4, but multer does not care');

const { signAccessToken } = require('../../services/tokenService');

/**
 * An upload, as an authenticated channel.
 *
 * `seeded` is a makeChannel() result; the token is signed from its user. The route now
 * takes the uploading channel from that token and ignores the form field entirely, so
 * the field is still sent here deliberately - several tests below assert that sending
 * it changes nothing.
 *
 * Pass `{ anonymous: true }` for the no-token case.
 */
const upload = (seeded, { async: asyncMode = false, token, anonymous = false, channelIdField } = {}) => {
    const req = request(app)
        .post(`/api/v2/upload${asyncMode ? '?mode=async' : ''}`)
        .field('title', 'A perfectly nice video')
        .field('description', 'Nothing untoward here')
        .field('tags', 'music,chill')
        .field('channelId', String(channelIdField ?? seeded?.channel?._id ?? seeded))
        .attach('video', FAKE_VIDEO, 'clip.mp4');

    const bearer = token ?? (anonymous ? null : seeded?.user && signAccessToken(seeded.user._id));
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req;
};

/** Poll a job until it reaches a terminal state. */
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

describe('POST /api/v2/upload (blocking)', () => {
    it('accepts a clean upload and stores video, transcript and an audit row', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;

        const res = await upload(seeded).expect(201);

        expect(res.body.video.title).toBe('A perfectly nice video');
        expect(await Video.countDocuments()).toBe(1);
        expect(await Transcript.countDocuments()).toBe(1);

        const attempt = await UploadAttempt.findOne().lean();
        expect(attempt.outcome).toBe('accepted');
        expect(attempt.video).not.toBeNull();

        // The channel owns the new video.
        const updated = await Channel.findById(channel._id).lean();
        expect(updated.videos).toHaveLength(1);
    });

    it('rejects on text and never reaches the expensive stages', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        moderation.__setVerdicts({ text: { safe: false, scores: { toxicity: 0.9 } } });

        const res = await upload(seeded).expect(400);

        expect(res.body.msg).toMatch(/Upload rejected/);
        // Additive field: the original msg is untouched, so an existing client keeps
        // working while a new one can tell the user WHICH part to change.
        expect(res.body.stage).toBe('text');

        // The ordering of the pipeline is the whole cost saving: a bad title must not
        // spend an ASR call or thirty image calls.
        expect(moderation.requestTranscript).not.toHaveBeenCalled();
        expect(moderation.requestFrames).not.toHaveBeenCalled();

        expect(await Video.countDocuments()).toBe(0);
    });

    it('records a rejection, which previously left no trace at all', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        moderation.__setVerdicts({ text: { safe: false, scores: { toxicity: 0.95 } } });

        await upload(seeded).expect(400);

        const attempt = await UploadAttempt.findOne().lean();
        expect(attempt.outcome).toBe('rejected');
        expect(attempt.stage).toBe('text');
        // The submitted text is kept verbatim. Without it a false positive cannot be
        // reviewed, which is exactly the complaint a user will bring.
        expect(attempt.title).toBe('A perfectly nice video');
        expect(attempt.scores).not.toBeNull();
    });

    it('destroys the Cloudinary assets when rejected', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        moderation.__setVerdicts({ text: { safe: false } });

        await upload(seeded).expect(400);

        expect(cloud.__destroyed.map((d) => d.publicId)).toContain('yteens_videos/test-video');
    });

    it('keeps the assets when accepted', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        await upload(seeded).expect(201);
        expect(cloud.__destroyed).toHaveLength(0);
    });

    it('reports stage "unavailable" when the transcript service is down', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        moderation.__setVerdicts({ transcript: new Error('service unreachable') });

        const res = await upload(seeded).expect(400);

        // Not the user's fault, and the client must be able to tell the difference so it
        // can offer a retry rather than accusing them of posting something unsafe.
        expect(res.body.stage).toBe('unavailable');
    });

    it("ignores a channelId form field naming someone else's channel", async () => {
        // This field used to decide who the video belonged to, and nothing verified it.
        // It is still accepted - so an older client does not break - but it no longer
        // has any effect: the upload lands on the channel that holds the token.
        const seeded = await makeChannel();
        const victim = await makeChannel();

        await upload(seeded, { channelIdField: String(victim.channel._id) }).expect(201);

        const video = await Video.findOne().lean();
        expect(String(video.channel)).toBe(String(seeded.channel._id));
        expect((await Channel.findById(victim.channel._id).lean()).videos).toHaveLength(0);
    });

    it('rejects an upload with no Authorization header', async () => {
        // This route is the one the app actually uploads through, so leaving it open to
        // an unverified form field would have made closing the legacy routes pointless.
        const seeded = await makeChannel();
        await upload(seeded, { anonymous: true }).expect(401);
        expect(await Video.countDocuments()).toBe(0);
    });

    it('refuses a signed-in user who has no channel yet', async () => {
        const { makeUser } = require('../helpers/seed');
        const user = await makeUser();

        await upload(null, { token: signAccessToken(user._id) }).expect(403);
    });
});

describe('POST /api/v2/upload?mode=async', () => {
    let seededAsync;
    let channel;
    let token;

    beforeEach(async () => {
        seededAsync = await makeChannel();
        channel = seededAsync.channel;
        token = signAccessToken(seededAsync.user._id);
    });

    it('returns 202 with a job id immediately', async () => {
        const res = await upload(seededAsync, { async: true, token }).expect(202);

        expect(res.body.data).toEqual(
            expect.objectContaining({
                jobId: expect.any(String),
                status: 'queued',
                statusUrl: expect.stringContaining('/api/v2/upload/jobs/'),
            })
        );
        // Nothing is published yet — that is the point of 202.
        expect(await Video.countDocuments()).toBe(0);
    });

    it('reaches accepted and publishes the video', async () => {
        const res = await upload(seededAsync, { async: true, token }).expect(202);

        const job = await waitForJob(res.body.data.jobId, token);

        expect(job.status).toBe('accepted');
        expect(job.pct).toBe(100);
        expect(job.video).toEqual(expect.any(String));
        expect(await Video.countDocuments()).toBe(1);
    });

    it('reaches rejected, publishes nothing, and cleans up', async () => {
        moderation.__setVerdicts({ text: { safe: false } });

        const res = await upload(seededAsync, { async: true, token }).expect(202);
        const job = await waitForJob(res.body.data.jobId, token);

        expect(job.status).toBe('rejected');
        expect(job.stage).toBe('text');
        expect(await Video.countDocuments()).toBe(0);
        expect(cloud.__destroyed.map((d) => d.publicId)).toContain('yteens_videos/test-video');
    });

    it('does not leak a job to another channel', async () => {
        const res = await upload(seededAsync, { async: true, token }).expect(202);

        const other = await makeChannel();
        const otherToken = signAccessToken(other.user._id);

        // 404, not 403: confirming the job exists but belongs to someone else still
        // leaks that it exists.
        await request(app)
            .get(`/api/v2/upload/jobs/${res.body.data.jobId}`)
            .set('Authorization', `Bearer ${otherToken}`)
            .expect(404);
    });

    it('requires a token to poll', async () => {
        const res = await upload(seededAsync, { async: true, token }).expect(202);
        await request(app).get(`/api/v2/upload/jobs/${res.body.data.jobId}`).expect(401);
    });
});

describe('sweepStaleJobs', () => {
    it('fails jobs abandoned by a dead process', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        const { sweepStaleJobs } = require('../../services/uploadJobRunner');

        await UploadJob.create({
            channel: channel._id,
            status: 'running',
            heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
        });

        // In-process jobs do not survive a restart. Without the sweep this row sits in
        // `running` forever and a client polls it until it gives up.
        expect(await sweepStaleJobs()).toBe(1);
        expect((await UploadJob.findOne().lean()).status).toBe('failed');
    });

    it('leaves a healthy job alone', async () => {
        const seeded = await makeChannel();
        const { channel } = seeded;
        const { sweepStaleJobs } = require('../../services/uploadJobRunner');

        await UploadJob.create({ channel: channel._id, status: 'running', heartbeatAt: new Date() });

        expect(await sweepStaleJobs()).toBe(0);
    });
});

describe('GET /api/v2/upload/attempts', () => {
    it('returns this channel\'s history without the raw scores', async () => {
        const seeded = await makeChannel();
        const token = signAccessToken(seeded.user._id);

        moderation.__setVerdicts({ text: { safe: false } });
        await upload(seeded).expect(400);

        const res = await request(app)
            .get('/api/v2/upload/attempts')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].stage).toBe('text');
        // Returning the raw per-stage scores would hand anyone a tuning oracle for the
        // moderation thresholds.
        expect(res.body.data[0].scores).toBeUndefined();
    });

    it('does not show another channel\'s attempts', async () => {
        const mine = await makeChannel();
        const theirs = await makeChannel();

        moderation.__setVerdicts({ text: { safe: false } });
        await upload(theirs).expect(400);

        const res = await request(app)
            .get('/api/v2/upload/attempts')
            .set('Authorization', `Bearer ${signAccessToken(mine.user._id)}`)
            .expect(200);

        expect(res.body.data).toHaveLength(0);
    });
});
