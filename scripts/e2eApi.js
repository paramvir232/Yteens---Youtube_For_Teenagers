#!/usr/bin/env node
/**
 * The whole API, end to end, against a running server.
 *
 *     npm run dev                 # in one terminal
 *     npm run e2e                 # in another
 *     npm run e2e -- --base http://192.168.1.4:3000
 *
 * This is deliberately NOT part of `npm test`. The Jest suite mocks Cloudinary, blocks
 * the network and talks to the app object directly, which is the right trade for speed
 * and determinism — and the reason it cannot catch a route that is mounted at the wrong
 * path, a server that will not boot, or a `.env` that points at the wrong database.
 * This script drives real HTTP against a real process.
 *
 * It creates everything it needs through the public API, so it also doubles as a check
 * that signing up actually works. Videos are the one exception: those are seeded
 * straight through Mongoose, because the alternative is paying Cloudinary for fixtures.
 *
 * Nothing here is destructive to data it did not create.
 */
require('dotenv').config({ quiet: true });

const mongoose = require('mongoose');
const { connectDB, resolveMongoUri } = require('../config/db');
const { mongoUriLocality } = require('../config/mongoUri');
const { makeChannel, makeVideo } = require('../test/helpers/seed');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const BASE = argValue('--base', 'http://localhost:3000').replace(/\/$/, '');

// ---------------------------------------------------------------- tiny harness

let passed = 0;
const failures = [];
let group = '';

const section = (name) => {
  group = name;
  console.log(`\n  ${name}`);
};

const ok = (label) => {
  passed += 1;
  console.log(`    ok    ${label}`);
};

const fail = (label, detail) => {
  failures.push({ group, label, detail });
  console.log(`    FAIL  ${label}\n            ${detail}`);
};

/** Run one check. A throw is a failure, not a crash — the rest still runs. */
async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err.message);
  }
}

const expect = (actual, wanted, what) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
};

const expectStatus = (res, wanted) => {
  if (res.status !== wanted) {
    throw new Error(`expected HTTP ${wanted}, got ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
  }
};

// ---------------------------------------------------------------- HTTP

async function request(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

const get = (p, o) => request('GET', p, o);
const post = (p, b, o) => request('POST', p, { ...o, body: b });
const del = (p, o) => request('DELETE', p, o);

// ---------------------------------------------------------------- actors

let actorSeq = 0;

/** A signed-up user with a channel and a live token, created through the real API. */
async function newActor(label) {
  actorSeq += 1;
  const stamp = `${Date.now().toString(36)}${actorSeq}`;
  const email = `e2e_${stamp}@example.com`;
  const password = 'password123';

  const signup = await post('/user/signup', {
    name: `e2e_${stamp}`.slice(0, 20),
    email,
    password,
    age: 16,
  });
  if (signup.status !== 201) {
    throw new Error(`could not sign up ${label}: ${signup.status} ${JSON.stringify(signup.body).slice(0, 160)}`);
  }

  const login = await post('/api/v2/auth/login', { email, password });
  if (login.status !== 200) {
    throw new Error(`could not log in ${label}: ${login.status}`);
  }

  const { accessToken, refreshToken } = login.body.data;

  const channel = await post('/channel/create', { name: `E2E ${stamp}`.slice(0, 30) }, { token: accessToken });
  if (![200, 201].includes(channel.status)) {
    throw new Error(`could not create a channel for ${label}: ${channel.status} ${JSON.stringify(channel.body).slice(0, 160)}`);
  }

  const me = await get('/api/v2/auth/me', { token: accessToken });
  return {
    label,
    email,
    password,
    accessToken,
    refreshToken,
    userId: me.body?.data?.user?.id ?? me.body?.data?.user?._id,
    channelId: me.body?.data?.channel?.id ?? me.body?.data?.channel?._id,
  };
}

// ---------------------------------------------------------------- the checks

async function authChecks() {
  section('Auth');

  const actor = await newActor('auth');

  await check('login returns an access token and a refresh token', () => {
    if (!actor.accessToken || !actor.refreshToken) throw new Error('one of them is missing');
  });

  await check('/me identifies the caller and their channel', async () => {
    const res = await get('/api/v2/auth/me', { token: actor.accessToken });
    expectStatus(res, 200);
    expect(res.body.data.user.email, actor.email, 'email');
    if (!res.body.data.channel) throw new Error('channel missing from /me');
  });

  await check('/me refuses a missing token', async () => {
    expectStatus(await get('/api/v2/auth/me'), 401);
  });

  await check('an unknown email and a wrong password give the SAME answer', async () => {
    // Otherwise the pair is a user-enumeration oracle: "which of our users exist" for
    // anyone willing to ask twice.
    const unknown = await post('/api/v2/auth/login', { email: `nobody_${Date.now()}@example.com`, password: 'password123' });
    const wrong = await post('/api/v2/auth/login', { email: actor.email, password: 'definitely-wrong' });
    expect([unknown.status, wrong.status], [401, 401], 'statuses');
  });

  let rotated;
  await check('refresh rotates the token', async () => {
    const res = await post('/api/v2/auth/refresh', { refreshToken: actor.refreshToken });
    expectStatus(res, 200);
    rotated = res.body.data.refreshToken;
    if (rotated === actor.refreshToken) throw new Error('the refresh token came back unchanged');
  });

  await check('replaying a rotated refresh token is refused', async () => {
    // Reuse detection. A token that has already been exchanged is either a copy in an
    // attacker's hands or a buggy client; either way it must not mint a session.
    const res = await post('/api/v2/auth/refresh', { refreshToken: actor.refreshToken });
    if (res.status === 200) throw new Error('the old token was accepted');
  });

  await check('the replay revokes the whole family, not just the replayed token', async () => {
    const res = await post('/api/v2/auth/refresh', { refreshToken: rotated });
    if (res.status === 200) throw new Error('the rotated token still worked after a replay');
  });

  await check('logout-all ends every session', async () => {
    const fresh = await newActor('logout');

    // 204 is what the route returns and is the right answer for "done, nothing to say".
    // Accepting both keeps this check about revocation rather than about a status code.
    const res = await post('/api/v2/auth/logout-all', {}, { token: fresh.accessToken });
    if (![200, 204].includes(res.status)) {
      throw new Error(`logout-all answered ${res.status}`);
    }

    const after = await post('/api/v2/auth/refresh', { refreshToken: fresh.refreshToken });
    if (after.status === 200) throw new Error('a refresh token survived logout-all');
  });
}

async function identityChecks() {
  section('Identity is taken from the token, never the body');

  const owner = await newActor('owner');
  const stranger = await newActor('stranger');

  await check('a write with no token is refused', async () => {
    expectStatus(await post(`/channel/subscribe/${owner.channelId}`, {}), 401);
  });

  await check('a malformed token is refused rather than treated as anonymous', async () => {
    const res = await post(`/channel/subscribe/${owner.channelId}`, {}, { token: 'not-a-real-token' });
    expectStatus(res, 401);
  });

  await check('a body channelId naming someone else is ignored', async () => {
    // The impersonation hole the whole auth phase existed to close.
    const res = await post(
      `/channel/subscribe/${owner.channelId}`,
      { subscriberId: owner.channelId },
      { token: stranger.accessToken }
    );
    expectStatus(res, 200);

    const target = await get(`/channel/getById/${owner.channelId}`);
    const subscribers = (target.body.subscribers?.channels || []).map(String);
    if (!subscribers.includes(String(stranger.channelId))) {
      throw new Error('the subscription was not attributed to the token holder');
    }
    if (subscribers.includes(String(owner.channelId))) {
      throw new Error('the body field won — the channel subscribed to itself');
    }
  });

  await check('a stranger cannot delete someone else\'s channel', async () => {
    expectStatus(await del(`/channel/delete/${owner.channelId}`, { token: stranger.accessToken }), 403);
  });

  await check('a stranger cannot rename someone else\'s channel', async () => {
    const res = await request('PUT', `/channel/updateDetails/${owner.channelId}`, {
      token: stranger.accessToken,
      body: { name: 'Taken Over' },
    });
    expectStatus(res, 403);
  });

  return { owner, stranger };
}

async function feedChecks() {
  section('Feed');

  const { channel } = await makeChannel();
  const seeded = [];
  for (let i = 0; i < 7; i += 1) {
    seeded.push(await makeVideo(channel, { title: `E2E feed video ${i}` }));
  }

  await check('the feed answers with data and paging metadata', async () => {
    const res = await get('/api/v2/feed?limit=3');
    expectStatus(res, 200);
    if (!Array.isArray(res.body.data)) throw new Error('data is not an array');
    for (const key of ['nextCursor', 'hasMore', 'limit']) {
      if (!(key in res.body.meta)) throw new Error(`meta.${key} missing`);
    }
  });

  await check('the projection leaves out the unbounded arrays', async () => {
    // This projection is the actual performance fix: GET /video/ ships every viewer and
    // commenter id for every video.
    const res = await get('/api/v2/feed?limit=1');
    const video = res.body.data[0];
    if (!video) throw new Error('no videos came back');
    if (video.views?.viewers) throw new Error('views.viewers is present');
    if (video.likes?.by) throw new Error('likes.by is present');
    if (Array.isArray(video.comments)) throw new Error('comments array is present');
  });

  await check('paging does not repeat or skip a video inserted mid-scroll', async () => {
    // The reason the cursor is on _id rather than a skip offset. A skip-based boundary
    // shifts under an insert, so a reader silently sees one video twice and misses another.
    const first = await get('/api/v2/feed?limit=3');
    expectStatus(first, 200);

    await makeVideo(channel, { title: 'E2E inserted mid-scroll' });

    const second = await get(`/api/v2/feed?limit=3&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
    expectStatus(second, 200);

    const firstIds = first.body.data.map((v) => String(v._id));
    const secondIds = second.body.data.map((v) => String(v._id));
    const overlap = secondIds.filter((id) => firstIds.includes(id));
    if (overlap.length) throw new Error(`page 2 repeated ${overlap.length} video(s) from page 1`);
  });

  await check('a search with no matches is an empty 200, not a 404', async () => {
    // The legacy /video/search/:query 404s on no results, which reads client-side as a
    // network error rather than "nothing found".
    const res = await get(`/api/v2/feed?q=zzz-definitely-no-such-title-${Date.now()}`);
    expectStatus(res, 200);
    expect(res.body.data.length, 0, 'result count');
  });

  await check('search finds a seeded title', async () => {
    const res = await get('/api/v2/feed?q=E2E%20feed%20video');
    expectStatus(res, 200);
    if (res.body.data.length === 0) throw new Error('the seeded videos were not found');
  });

  return { channel, seeded };
}

async function communityChecks(owner, stranger) {
  section('Communities');

  const community = `/api/v2/communities/${owner.channelId}`;

  await check('a non-subscriber cannot join', async () => {
    const outsider = await newActor('outsider');
    const res = await post(`${community}/join`, {}, { token: outsider.accessToken });
    if (res.status === 201 || res.status === 200) {
      throw new Error('joining did not require a subscription');
    }
  });

  await check('a subscriber can join', async () => {
    // stranger already subscribed during the identity checks.
    const res = await post(`${community}/join`, {}, { token: stranger.accessToken });
    if (![200, 201].includes(res.status)) {
      throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
  });

  let postId;
  await check('a member can post, and it is moderated', async () => {
    const res = await post(`${community}/posts`, { body: 'A perfectly ordinary first post.' }, { token: stranger.accessToken });
    if (res.status === 503) throw new Error('moderation unavailable — is the stub or a Space running?');
    expectStatus(res, 201);
    postId = res.body.data.id || res.body.data._id;
  });

  await check('unsafe content is refused with a stage and no raw scores', async () => {
    // Needs the stub (npm run stub:moderation): REJECT forces an unsafe verdict.
    const res = await post(`${community}/posts`, { body: 'please REJECT this one' }, { token: stranger.accessToken });
    if (res.status === 201) {
      throw new Error('the content was accepted — is the stub running, or is a real Space answering?');
    }
    expectStatus(res, 422);
    const payload = JSON.stringify(res.body);
    if (!payload.includes('stage')) throw new Error('no stage in the rejection');
    // Raw toxicity scores are a tuning oracle for anyone probing the threshold.
    if (/toxicity|nsfw_score|violence_score/.test(payload)) {
      throw new Error('raw moderation scores leaked to the client');
    }
  });

  await check('a comment can reply to another comment', async () => {
    const parent = await post(`/api/v2/communities/posts/${postId}/comments`, { body: 'top level' }, { token: stranger.accessToken });
    expectStatus(parent, 201);
    const parentId = parent.body.data.id || parent.body.data._id;

    const reply = await post(
      `/api/v2/communities/posts/${postId}/comments`,
      { body: 'a reply', parentId },
      { token: stranger.accessToken }
    );
    expectStatus(reply, 201);
  });

  await check('a post can be voted on', async () => {
    const res = await post(`/api/v2/communities/posts/${postId}/vote`, { value: 1 }, { token: stranger.accessToken });
    if (![200, 201].includes(res.status)) throw new Error(`vote failed: ${res.status}`);
  });

  await check('the owner can delete a member\'s post', async () => {
    const res = await del(`/api/v2/communities/posts/${postId}`, { token: owner.accessToken });
    if (![200, 204].includes(res.status)) throw new Error(`owner delete failed: ${res.status}`);
  });

  await check('a banned member is refused, and says so', async () => {
    const banned = await post(
      `${community}/members/${stranger.channelId}/ban`,
      { reason: 'e2e' },
      { token: owner.accessToken }
    );
    if (![200, 201].includes(banned.status)) throw new Error(`ban failed: ${banned.status}`);

    const res = await post(`${community}/posts`, { body: 'after the ban' }, { token: stranger.accessToken });
    expectStatus(res, 403);
    if (!JSON.stringify(res.body).includes('BANNED')) {
      throw new Error('a ban surfaced as a generic refusal');
    }
  });

  await check('a ban survives leaving and re-subscribing', async () => {
    // Otherwise unsubscribe → resubscribe → rejoin is one-click ban evasion.
    await post(`/channel/unsubscribe/${owner.channelId}`, {}, { token: stranger.accessToken });
    await post(`/channel/subscribe/${owner.channelId}`, {}, { token: stranger.accessToken });

    const res = await post(`${community}/join`, {}, { token: stranger.accessToken });
    if (res.status === 200 || res.status === 201) {
      throw new Error('a banned channel re-joined by resubscribing');
    }
  });
}

async function legacyChecks() {
  section('Legacy contract');

  await check('GET /video still returns a bare unbounded array with no token', async () => {
    // Every pre-token client depends on this exact shape.
    const res = await get('/video');
    expectStatus(res, 200);
    if (!Array.isArray(res.body)) throw new Error('the response is not a bare array');
  });

  await check('the health routes answer', async () => {
    expectStatus(await get('/wake-up'), 200);
  });
}

// ---------------------------------------------------------------- run

async function main() {
  const uri = resolveMongoUri();
  const { local, reason } = mongoUriLocality(uri);

  console.log(`\nEnd-to-end API checks against ${BASE}`);
  console.log(`Database: ${uri.replace(/\/\/[^@]*@/, '//<credentials>@')}`);

  if (!local && !argv.includes('--allow-remote')) {
    console.error(
      `\nRefusing to run: ${reason}. This script creates users, channels and videos; ` +
      'it is for a local database. Re-run with --allow-remote if you really mean it.\n'
    );
    process.exit(1);
  }

  const awake = await get('/wake-up').catch(() => null);
  if (!awake || awake.status !== 200) {
    console.error(`\nNothing is answering at ${BASE}. Start it with \`npm run dev\`.\n`);
    process.exit(1);
  }

  await connectDB();

  try {
    await authChecks();
    const { owner, stranger } = await identityChecks();
    await feedChecks();
    await communityChecks(owner, stranger);
    await legacyChecks();
  } finally {
    await mongoose.disconnect();
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED  ${f.group} › ${f.label}\n          ${f.detail}`);
    console.log('');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\ne2e run failed:', err.message, '\n');
    process.exit(1);
  });
}
