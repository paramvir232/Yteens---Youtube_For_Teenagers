/**
 * Factories for integration tests.
 *
 * Documents are created through the real Mongoose models, never inserted raw, so schema
 * validation and hooks actually run. That matters most for User: its password is hashed
 * by a pre('save') hook, so a raw insert would store plaintext and every login test
 * would pass for the wrong reason.
 *
 * Emails are randomised because the User schema has a unique index on email and tests
 * within a file share one database.
 */
const User = require('../../models/usersModel');
const Channel = require('../../models/channelModel');
const Video = require('../../models/videoModel');

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter += 1).toString(36)}`;

async function makeUser(overrides = {}) {
  return User.create({
    userName: `user_${uniq()}`.slice(0, 20),
    email: `user_${uniq()}@example.com`,
    password: 'password123',
    age: 16,
    ...overrides,
  });
}

/** A channel, and the user that owns it. Channel.user is unique, so each call makes both. */
async function makeChannel(overrides = {}) {
  const user = overrides.user ? null : await makeUser();
  const channel = await Channel.create({
    name: `Channel ${uniq()}`.slice(0, 30),
    user: overrides.user || user._id,
    ...overrides,
  });
  return { channel, user };
}

async function makeVideo(channel, overrides = {}) {
  return Video.create({
    url: 'https://res.cloudinary.com/demo/video/upload/sample.mp4',
    title: `video-${uniq()}`,
    description: 'seeded',
    tags: [],
    channel: channel._id,
    ...overrides,
  });
}

/**
 * N videos on one channel, created SEQUENTIALLY and titled `${prefix}-0..N-1`.
 *
 * Sequential rather than Promise.all on purpose: ObjectIds encode creation order, the
 * feed cursor sorts by _id, and tests assert on exact ordering. Creating them in
 * parallel makes that order non-deterministic and the assertions flaky.
 */
async function makeVideos(channel, count, { titlePrefix = 'video' } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await makeVideo(channel, { title: `${titlePrefix}-${i}` }));
  }
  return out;
}

/** Make `subscriber` a subscriber of `target`, the way channelRoute does it. */
async function subscribe(targetChannel, subscriberChannel) {
  await Channel.findByIdAndUpdate(targetChannel._id, {
    $addToSet: { 'subscribers.channels': subscriberChannel._id },
    $inc: { 'subscribers.count': 1 },
  });
  await Channel.findByIdAndUpdate(subscriberChannel._id, {
    $addToSet: { subscribed: targetChannel._id },
  });
}

module.exports = { makeUser, makeChannel, makeVideo, makeVideos, subscribe };
