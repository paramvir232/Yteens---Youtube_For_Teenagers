process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

const request = require('supertest');

const app = require('../../app');
const Channel = require('../../models/channelModel');
const { makeUser } = require('../helpers/seed');
const { signAccessToken } = require('../../services/tokenService');

/**
 * Creating a channel — the first thing a new account must do.
 *
 * Everything else is gated behind it: uploading, subscribing, joining a community. A
 * failure here is not one broken screen, it is a dead end for every new user, which is
 * exactly what happened: the app appends `description` to its multipart form whether or
 * not the bio was filled in, so a blank bio sent `description=""`, and
 * `Joi.string().optional()` rejects an empty string while accepting a missing one.
 */
async function signedUp() {
  const user = await makeUser();
  return { user, token: signAccessToken(user._id) };
}

describe('POST /channel/create', () => {
  it('accepts a channel with no bio, sent as an empty field', async () => {
    // Precisely what the upload screen sends when Station Bio is left blank.
    const { user, token } = await signedUp();

    const res = await request(app)
      .post('/channel/create')
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'No Bio Channel')
      .field('description', '');

    expect(res.status).toBe(201);
    const channel = await Channel.findOne({ user: user._id }).lean();
    expect(channel.name).toBe('No Bio Channel');
    expect(channel.description).toBe('');
  });

  it('accepts a channel with no description field at all', async () => {
    const { token } = await signedUp();
    await request(app)
      .post('/channel/create')
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Absent Bio')
      .expect(201);
  });

  it('accepts a bio when one is given', async () => {
    const { user, token } = await signedUp();
    await request(app)
      .post('/channel/create')
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'With Bio')
      .field('description', 'Clips about building things')
      .expect(201);

    const channel = await Channel.findOne({ user: user._id }).lean();
    expect(channel.description).toBe('Clips about building things');
  });

  it('still rejects a name that is too short', async () => {
    // The relaxation is for the optional field only; required validation stands.
    const { token } = await signedUp();
    await request(app)
      .post('/channel/create')
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'x')
      .expect(400);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).post('/channel/create').field('name', 'Nobody').expect(401);
  });

  it('creates the channel for the token holder, not a userId in the body', async () => {
    const { user, token } = await signedUp();
    const other = await makeUser();

    await request(app)
      .post('/channel/create')
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Mine Not Theirs')
      .field('userId', String(other._id))
      .expect(201);

    expect(await Channel.findOne({ user: other._id })).toBeNull();
    expect(await Channel.findOne({ user: user._id })).not.toBeNull();
  });

  it('refuses a second channel for the same account', async () => {
    const { token } = await signedUp();
    await request(app).post('/channel/create').set('Authorization', `Bearer ${token}`)
      .field('name', 'First').expect(201);
    await request(app).post('/channel/create').set('Authorization', `Bearer ${token}`)
      .field('name', 'Second').expect(409);
  });
});
