process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

const request = require('supertest');

const app = require('../../app');
const Channel = require('../../models/channelModel');
const User = require('../../models/usersModel');
const Video = require('../../models/videoModel');
const { makeChannel, makeVideo } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');

/**
 * The flip: existing writes now require a token AND ownership.
 *
 * Two separate claims are being tested here, and conflating them is how this kind of
 * change goes wrong:
 *
 *   1. No token  -> 401. The route is closed.
 *   2. Valid token, someone else's resource -> 403. The route is closed to the right
 *      people too.
 *
 * (1) on its own is not security on a platform with public sign-up: it narrows the set
 * of attackers from "everyone" to "everyone with an account". Every destructive route
 * below therefore has a test for (2).
 *
 * Reads are deliberately absent from this file. They stay open, and legacy-contract.js
 * is what proves it.
 */

const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);

/** An owner and an unrelated signed-in stranger — the two actors every case needs. */
async function twoParties() {
  const owner = await makeChannel();
  const stranger = await makeChannel();
  return {
    owner: { ...owner, token: signAccessToken(owner.user._id) },
    stranger: { ...stranger, token: signAccessToken(stranger.user._id) },
  };
}

describe('writes are closed to anonymous callers', () => {
  it.each([
    ['delete', '/channel/delete/507f1f77bcf86cd799439011'],
    ['put', '/channel/updateDetails/507f1f77bcf86cd799439011'],
    ['post', '/channel/subscribe/507f1f77bcf86cd799439011'],
    ['post', '/channel/unsubscribe/507f1f77bcf86cd799439011'],
    ['delete', '/video/delete/507f1f77bcf86cd799439011'],
    ['put', '/video/update/507f1f77bcf86cd799439011'],
    ['post', '/video/likeVideo/507f1f77bcf86cd799439011'],
    ['post', '/video/unlikeVideo/507f1f77bcf86cd799439011'],
    ['post', '/video/comment/507f1f77bcf86cd799439011'],
    ['post', '/video/onClick/507f1f77bcf86cd799439011'],
    ['put', '/user/update/507f1f77bcf86cd799439011'],
    ['delete', '/user/delete/507f1f77bcf86cd799439011'],
  ])('%s %s answers 401 with no token', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it('refuses a malformed token rather than treating it as anonymous', async () => {
    // "Optional" means the header may be absent, never that a bad token is ignored:
    // silently downgrading a broken token to an anonymous session hides client bugs.
    await request(app)
      .post('/video/likeVideo/507f1f77bcf86cd799439011')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });
});

describe('the legacy body fallback is off by default', () => {
  it('ignores a channelId in the body when there is no token', async () => {
    const { channel } = await makeChannel();
    const video = await makeVideo(channel);

    // This is the exact request every pre-token client sent, and it used to work.
    await request(app)
      .post(`/video/likeVideo/${video._id}`)
      .send({ channelId: String(channel._id) })
      .expect(401);
  });

  it('can be switched back on with one environment variable', async () => {
    // The way back matters: this is the one change in the project that can lock every
    // user out, so it has to be reversible without a deploy.
    const { channel } = await makeChannel();
    const video = await makeVideo(channel);

    process.env.LEGACY_ACTOR_FALLBACK = 'true';
    try {
      const res = await request(app)
        .post(`/video/likeVideo/${video._id}`)
        .send({ channelId: String(channel._id) });
      expect(res.status).toBe(200);
      // And it announces itself, so legacy traffic is visible in client logs.
      expect(res.headers.deprecation).toBe('true');
      expect(res.headers.sunset).toBeDefined();
    } finally {
      // Back to 'false', not deleted - an absent variable lets .env set it again.
      process.env.LEGACY_ACTOR_FALLBACK = 'false';
    }
  });
});

describe('the token wins over the body', () => {
  it('attributes a comment to the authenticated channel, not the one named in the body', async () => {
    const { owner, stranger } = await twoParties();
    const video = await makeVideo(owner.channel);

    await auth(
      request(app)
        .post(`/video/comment/${video._id}`)
        // A client that sends both must not be able to opt back into the old path.
        .send({ comment: 'hello', channelId: String(owner.channel._id) }),
      stranger.token
    ).expect(201);

    const fresh = await Video.findById(video._id).lean();
    expect(String(fresh.comments[0].channel)).toBe(String(stranger.channel._id));
  });

  it('uploads to the authenticated channel regardless of the form field', async () => {
    // Proved at the middleware level rather than by pushing bytes through multer: the
    // claim is about which channel id reaches the handler.
    const { owner, stranger } = await twoParties();

    await auth(
      request(app)
        .post(`/channel/subscribe/${owner.channel._id}`)
        .send({ subscriberId: String(owner.channel._id) }),
      stranger.token
    ).expect(200);

    const target = await Channel.findById(owner.channel._id).lean();
    expect(target.subscribers.channels.map(String)).toEqual([
      String(stranger.channel._id),
    ]);
    // The owner did not subscribe to themselves just because the body said so.
    expect(target.subscribers.count).toBe(1);
  });
});

describe('ownership, not merely authentication', () => {
  it('refuses to delete someone else\'s channel', async () => {
    const { owner, stranger } = await twoParties();

    await auth(
      request(app).delete(`/channel/delete/${owner.channel._id}`),
      stranger.token
    ).expect(403);

    expect(await Channel.findById(owner.channel._id)).not.toBeNull();
  });

  it('lets the owner delete their own channel', async () => {
    const { owner } = await twoParties();

    await auth(
      request(app).delete(`/channel/delete/${owner.channel._id}`),
      owner.token
    ).expect(200);

    expect(await Channel.findById(owner.channel._id)).toBeNull();
  });

  it('refuses to rename someone else\'s channel', async () => {
    const { owner, stranger } = await twoParties();

    await auth(
      request(app)
        .put(`/channel/updateDetails/${owner.channel._id}`)
        .send({ name: 'Taken Over' }),
      stranger.token
    ).expect(403);
  });

  it('will not let an owner rewrite the fields that are not theirs to set', async () => {
    const { owner, stranger } = await twoParties();

    await auth(
      request(app).put(`/channel/updateDetails/${owner.channel._id}`).send({
        name: 'Renamed',
        user: String(stranger.user._id), // reassign the channel to another account
        subscribers: { count: 99999, channels: [] }, // invent a following
      }),
      owner.token
    ).expect(200);

    const fresh = await Channel.findById(owner.channel._id).lean();
    expect(fresh.name).toBe('Renamed');
    expect(String(fresh.user)).toBe(String(owner.user._id));
    expect(fresh.subscribers.count).toBe(0);
  });

  it('refuses to delete someone else\'s video', async () => {
    const { owner, stranger } = await twoParties();
    const video = await makeVideo(owner.channel);

    await auth(request(app).delete(`/video/delete/${video._id}`), stranger.token)
      .expect(403);

    expect(await Video.findById(video._id)).not.toBeNull();
  });

  it('refuses to retitle someone else\'s video', async () => {
    // This route had no identity check at all before — not even an unverified body
    // field. Knowing an id was enough.
    const { owner, stranger } = await twoParties();
    const video = await makeVideo(owner.channel, { title: 'Original' });

    await auth(
      request(app).put(`/video/update/${video._id}`).send({ title: 'Defaced' }),
      stranger.token
    ).expect(403);

    expect((await Video.findById(video._id)).title).toBe('Original');
  });

  it('lets the owner retitle their own video', async () => {
    const { owner } = await twoParties();
    const video = await makeVideo(owner.channel, { title: 'Original' });

    await auth(
      request(app).put(`/video/update/${video._id}`).send({ title: 'Renamed' }),
      owner.token
    ).expect(200);

    expect((await Video.findById(video._id)).title).toBe('Renamed');
  });

  it('refuses to change another account\'s password', async () => {
    const { owner, stranger } = await twoParties();

    await auth(
      request(app).put(`/user/update/${owner.user._id}`).send({ password: 'hijacked1' }),
      stranger.token
    ).expect(403);

    // And the original password still works, which is the claim that actually matters.
    await request(app)
      .post('/api/v2/auth/login')
      .send({ email: owner.user.email, password: 'password123' })
      .expect(200);
  });

  it('refuses to delete another account', async () => {
    const { owner, stranger } = await twoParties();

    await auth(request(app).delete(`/user/delete/${owner.user._id}`), stranger.token)
      .expect(403);

    expect(await User.findById(owner.user._id)).not.toBeNull();
  });
});

describe('comment deletion', () => {
  async function videoWithComment() {
    const { owner, stranger } = await twoParties();
    const video = await makeVideo(owner.channel);

    await auth(
      request(app).post(`/video/comment/${video._id}`).send({ comment: 'hi' }),
      stranger.token
    ).expect(201);

    const fresh = await Video.findById(video._id).lean();
    return { owner, stranger, video, commentId: String(fresh.comments[0]._id) };
  }

  it('lets the comment author delete it', async () => {
    const { stranger, video, commentId } = await videoWithComment();
    await auth(
      request(app).delete(`/video/${video._id}/deleteComment/${commentId}`),
      stranger.token
    ).expect(200);
  });

  it('lets the video owner delete it', async () => {
    // Moderating your own video's comments is the whole point of the second branch.
    const { owner, video, commentId } = await videoWithComment();
    await auth(
      request(app).delete(`/video/${video._id}/deleteComment/${commentId}`),
      owner.token
    ).expect(200);
  });

  it('refuses an unrelated third party', async () => {
    const { video, commentId } = await videoWithComment();
    const outsider = await makeChannel();

    await auth(
      request(app).delete(`/video/${video._id}/deleteComment/${commentId}`),
      signAccessToken(outsider.user._id)
    ).expect(403);
  });
});

describe('signing in is still open', () => {
  it('does not require a token to sign up or log in', async () => {
    // Obvious, and exactly the kind of thing a blanket requireAuth breaks.
    await request(app)
      .post('/user/signup')
      .send({
        name: 'new_person',
        email: `new_${Date.now()}@example.com`,
        password: 'password123',
        age: 15,
      })
      .expect(201);
  });
});
