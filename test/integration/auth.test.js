process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-integration';

const request = require('supertest');

const app = require('../../app');
const RefreshToken = require('../../models/refreshTokenModel');
const User = require('../../models/usersModel');
const { makeUser, makeChannel } = require('../helpers/seed');

const PASSWORD = 'password123';

/** A user created through the real model, so the pre('save') bcrypt hook runs. */
async function registeredUser(overrides = {}) {
    return makeUser({ password: PASSWORD, ...overrides });
}

const login = (email, password = PASSWORD) =>
    request(app).post('/api/v2/auth/login').send({ email, password });

describe('POST /api/v2/auth/login', () => {
    it('returns a token pair and the session payload', async () => {
        const user = await registeredUser();

        const res = await login(user.email).expect(200);

        expect(res.body.data).toEqual(
            expect.objectContaining({
                accessToken: expect.any(String),
                refreshToken: expect.any(String),
                expiresIn: expect.any(String),
                user: { id: String(user._id), userName: user.userName, email: user.email },
                channel: null,
            })
        );
    });

    it('works for a user that existed before tokens were introduced', async () => {
        // The whole migration story: an account created by the old signup route, with a
        // bcrypt hash in the database and nothing else, logs in and gets tokens. No
        // document is modified, no backfill is run.
        const user = await registeredUser();
        const before = await User.findById(user._id).lean();

        await login(user.email).expect(200);

        expect(await User.findById(user._id).lean()).toEqual(before);
    });

    it('includes the channel when the user has one', async () => {
        const user = await registeredUser();
        const { channel } = await makeChannel({ user: user._id, name: 'My Channel' });

        const res = await login(user.email).expect(200);

        expect(res.body.data.channel).toEqual(
            expect.objectContaining({ id: String(channel._id), name: 'My Channel' })
        );
    });

    it('gives the same 401 for a wrong password and an unknown email', async () => {
        const user = await registeredUser();

        const wrongPassword = await login(user.email, 'not-the-password').expect(401);
        const unknownEmail = await login('nobody@example.com').expect(401);

        // Different responses here would let anyone discover which emails have accounts.
        // The legacy /user/login returns 404 vs 401 and is left as it is.
        expect(wrongPassword.body).toEqual(unknownEmail.body);
    });

    it('rejects a missing password without running a lookup', async () => {
        const res = await request(app).post('/api/v2/auth/login').send({ email: 'a@b.c' }).expect(400);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('stores the refresh token hashed, never in plaintext', async () => {
        const user = await registeredUser();
        const res = await login(user.email).expect(200);

        const stored = await RefreshToken.findOne({ user: user._id }).lean();

        expect(stored.tokenHash).not.toBe(res.body.data.refreshToken);
        expect(stored.tokenHash).toHaveLength(64);
        expect(JSON.stringify(stored)).not.toContain(res.body.data.refreshToken);
    });
});

describe('POST /api/v2/auth/refresh', () => {
    it('rotates the token and returns a new pair', async () => {
        const user = await registeredUser();
        const first = (await login(user.email).expect(200)).body.data;

        const res = await request(app)
            .post('/api/v2/auth/refresh')
            .send({ refreshToken: first.refreshToken })
            .expect(200);

        expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
    });

    it('revokes the old token once rotated', async () => {
        const user = await registeredUser();
        const first = (await login(user.email)).body.data;

        await request(app).post('/api/v2/auth/refresh').send({ refreshToken: first.refreshToken });

        const { hashToken } = require('../../services/tokenService');
        const old = await RefreshToken.findOne({ tokenHash: hashToken(first.refreshToken) }).lean();
        expect(old.revokedAt).not.toBeNull();
        expect(old.replacedBy).toEqual(expect.any(String));
    });

    it('detects reuse and signs out the whole family', async () => {
        const user = await registeredUser();
        const first = (await login(user.email)).body.data;

        const second = (
            await request(app).post('/api/v2/auth/refresh').send({ refreshToken: first.refreshToken })
        ).body.data;

        // Replaying the already-rotated token. Either an old copy was restored or a
        // token was stolen and is in use by two parties; we cannot tell which, so every
        // token descended from this login is revoked.
        const replay = await request(app)
            .post('/api/v2/auth/refresh')
            .send({ refreshToken: first.refreshToken })
            .expect(401);

        expect(replay.body.error.code).toBe('TOKEN_REUSED');

        // The legitimate holder's current token is dead too — that is the point.
        await request(app)
            .post('/api/v2/auth/refresh')
            .send({ refreshToken: second.refreshToken })
            .expect(401);
    });

    it('rejects an unknown token', async () => {
        const res = await request(app)
            .post('/api/v2/auth/refresh')
            .send({ refreshToken: 'not-a-real-token' })
            .expect(401);
        expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('rejects an expired token', async () => {
        const user = await registeredUser();
        const { refreshToken } = (await login(user.email)).body.data;

        const { hashToken } = require('../../services/tokenService');
        await RefreshToken.updateOne(
            { tokenHash: hashToken(refreshToken) },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );

        const res = await request(app)
            .post('/api/v2/auth/refresh')
            .send({ refreshToken })
            .expect(401);
        expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });
});

describe('POST /api/v2/auth/logout', () => {
    it('revokes the token and is idempotent', async () => {
        const user = await registeredUser();
        const { refreshToken } = (await login(user.email)).body.data;

        await request(app).post('/api/v2/auth/logout').send({ refreshToken }).expect(204);
        // Signing out twice is not an error, and must not report whether the token was
        // recognised — that would be a probe for live tokens.
        await request(app).post('/api/v2/auth/logout').send({ refreshToken }).expect(204);

        await request(app).post('/api/v2/auth/refresh').send({ refreshToken }).expect(401);
    });
});

describe('GET /api/v2/auth/me', () => {
    it('returns the user and channel for a valid token', async () => {
        const user = await registeredUser();
        await makeChannel({ user: user._id, name: 'Mine' });
        const { accessToken } = (await login(user.email)).body.data;

        const res = await request(app)
            .get('/api/v2/auth/me')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(200);

        expect(res.body.data.user.id).toBe(String(user._id));
        expect(res.body.data.channel.name).toBe('Mine');
    });

    it('never returns the password hash', async () => {
        const user = await registeredUser();
        const { accessToken } = (await login(user.email)).body.data;

        const res = await request(app)
            .get('/api/v2/auth/me')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(200);

        expect(JSON.stringify(res.body)).not.toContain('$2b$');
        expect(res.body.data.user.password).toBeUndefined();
    });

    it.each([
        ['no header', undefined, 'TOKEN_MISSING'],
        ['a malformed header', 'NotBearer xyz', 'TOKEN_MISSING'],
        ['a garbage token', 'Bearer garbage', 'TOKEN_INVALID'],
    ])('rejects %s', async (_label, header, code) => {
        const req = request(app).get('/api/v2/auth/me');
        if (header) req.set('Authorization', header);

        const res = await req.expect(401);
        expect(res.body.error.code).toBe(code);
    });
});

describe('POST /api/v2/auth/logout-all', () => {
    it('revokes every session for the user', async () => {
        const user = await registeredUser();
        const a = (await login(user.email)).body.data;
        const b = (await login(user.email)).body.data; // a second device

        await request(app)
            .post('/api/v2/auth/logout-all')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .expect(204);

        await request(app).post('/api/v2/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
        await request(app).post('/api/v2/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401);
    });
});

describe('nothing existing is now protected', () => {
    it('still serves GET /video/ with no token', async () => {
        await request(app).get('/video/').expect(200);
    });

    it('still serves GET /channel/ with no token', async () => {
        await request(app).get('/channel/').expect(200);
    });

    it('still accepts the legacy POST /user/login unchanged', async () => {
        const user = await registeredUser();

        const res = await request(app)
            .post('/user/login')
            .send({ email: user.email, password: PASSWORD })
            .expect(200);

        expect(res.body).toEqual({
            msg: 'Login successful',
            user: { id: String(user._id), name: user.userName },
        });
    });
});
