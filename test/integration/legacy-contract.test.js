/**
 * THE REGRESSION GUARD FOR THE WHOLE PROJECT.
 *
 * Every phase of this work adds new endpoints, new collections and new middleware beside
 * the existing app, on the promise that nothing already working changes. This file is
 * where that promise is checked. It asserts the exact wire contract the current frontend
 * depends on - response shapes, status codes, and the absence of any new requirement
 * such as an auth header.
 *
 * Rules for this file:
 *   - It grows one describe block per legacy route that any phase touches or routes
 *     around. It never shrinks.
 *   - An assertion here failing is not a test to update; it means a constraint was
 *     broken and the change needs rethinking.
 *   - Requests here deliberately send NO Authorization header. Once auth lands, these
 *     must still pass, because the existing client has no token to send.
 */
const request = require('supertest');

const app = require('../../app');
const User = require('../../models/usersModel');
const Channel = require('../../models/channelModel');
const Video = require('../../models/videoModel');

async function seedVideo(overrides = {}) {
  const user = await User.create({
    userName: 'legacy_user',
    email: `legacy_${Math.random().toString(36).slice(2)}@example.com`,
    password: 'password123',
    age: 15,
  });
  const channel = await Channel.create({ name: 'Legacy Channel', user: user._id });
  const video = await Video.create({
    url: 'https://res.cloudinary.com/demo/video/upload/sample.mp4',
    title: 'Legacy video',
    description: 'seeded by the legacy contract test',
    tags: ['legacy'],
    channel: channel._id,
    ...overrides,
  });
  return { user, channel, video };
}

describe('legacy contract: GET /video/', () => {
  it('returns a BARE ARRAY, not an object with a data key', async () => {
    await seedVideo();

    const res = await request(app).get('/video/').expect(200);

    // The frontend does `const videos = await getVideos()` and maps straight over the
    // result. Wrapping this in { data } would break every screen at once.
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns every video, unbounded, with no pagination applied', async () => {
    for (let i = 0; i < 25; i += 1) await seedVideo({ title: `video-${i}` });

    const res = await request(app).get('/video/').expect(200);

    expect(res.body).toHaveLength(await Video.countDocuments());
  });

  it('ignores a limit query param rather than honouring it', async () => {
    for (let i = 0; i < 5; i += 1) await seedVideo({ title: `video-${i}` });

    const res = await request(app).get('/video/?limit=1').expect(200);

    // Pagination belongs to the new feed endpoint. If someone ever "helpfully" teaches
    // this route to read req.query, a client that happens to append a query string
    // silently starts receiving a truncated feed.
    expect(res.body).toHaveLength(5);
  });

  it('populates channel with just _id and name', async () => {
    await seedVideo();

    const [video] = (await request(app).get('/video/').expect(200)).body;

    expect(video.channel).toEqual(
      expect.objectContaining({ _id: expect.any(String), name: 'Legacy Channel' })
    );
  });

  it('requires no Authorization header', async () => {
    await seedVideo();
    await request(app).get('/video/').expect(200);
  });
});

describe('legacy contract: GET /channel/', () => {
  it('returns a bare array with no auth', async () => {
    await seedVideo();

    const res = await request(app).get('/channel/').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });
});

describe('legacy contract: POST /user/login', () => {
  it('returns { msg, user: { id, name } } and NO token', async () => {
    await User.create({
      userName: 'login_user',
      email: 'login_user@example.com',
      password: 'password123',
      age: 16,
    });

    const res = await request(app)
      .post('/user/login')
      .send({ email: 'login_user@example.com', password: 'password123' })
      .expect(200);

    expect(res.body).toEqual({
      msg: 'Login successful',
      user: { id: expect.any(String), name: 'login_user' },
    });

    // Phase 2 adds tokens to a NEW endpoint. If they ever appear here it is fine
    // (additive), but the three keys above must keep their exact shape - the frontend
    // reads res.data.user.id directly.
  });
});

describe('legacy contract: unknown routes', () => {
  it('still 404s rather than being swallowed by a new catch-all', async () => {
    await request(app).get('/definitely-not-a-route').expect(404);
  });
});
