const jwt = require('jsonwebtoken');

process.env.JWT_ACCESS_SECRET = 'test-secret-for-unit-tests';

const {
    signAccessToken,
    verifyAccessToken,
    hashToken,
} = require('../../services/tokenService');

describe('access tokens', () => {
    it('round-trips a user id', () => {
        const token = signAccessToken('507f1f77bcf86cd799439011');
        expect(verifyAccessToken(token)).toEqual({ userId: '507f1f77bcf86cd799439011' });
    });

    it('rejects a token signed with a different secret', () => {
        const forged = jwt.sign({ sub: 'someone', typ: 'access' }, 'not-our-secret');
        expect(() => verifyAccessToken(forged)).toThrow();
    });

    it('rejects a tampered payload', () => {
        const token = signAccessToken('507f1f77bcf86cd799439011');
        const [header, , signature] = token.split('.');
        const payload = Buffer.from(
            JSON.stringify({ sub: 'attacker', typ: 'access' })
        ).toString('base64url');

        expect(() => verifyAccessToken(`${header}.${payload}.${signature}`)).toThrow();
    });

    it('rejects an expired token', () => {
        const expired = jwt.sign(
            { sub: 'u1', typ: 'access' },
            process.env.JWT_ACCESS_SECRET,
            { expiresIn: '-1s' }
        );
        expect(() => verifyAccessToken(expired)).toThrow(/expired/i);
    });

    it('rejects a correctly-signed token of the wrong type', () => {
        // Without the typ check, any token signed with the same secret — a refresh
        // token, a password-reset token, anything added later — would be accepted as
        // proof of an authenticated session.
        const wrongType = jwt.sign(
            { sub: 'u1', typ: 'password-reset' },
            process.env.JWT_ACCESS_SECRET
        );
        expect(() => verifyAccessToken(wrongType)).toThrow(/token type/i);
    });

    it('rejects a token with the algorithm stripped', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: 'attacker', typ: 'access' })).toString('base64url');
        expect(() => verifyAccessToken(`${header}.${payload}.`)).toThrow();
    });

    it('gives two tokens for the same user different ids', () => {
        // The jti makes tokens individually identifiable, which a future revocation
        // list would need.
        const a = jwt.decode(signAccessToken('u1'));
        const b = jwt.decode(signAccessToken('u1'));
        expect(a.jti).not.toBe(b.jti);
    });
});

describe('hashToken', () => {
    it('is stable for the same input', () => {
        expect(hashToken('abc')).toBe(hashToken('abc'));
    });

    it('differs for different inputs', () => {
        expect(hashToken('abc')).not.toBe(hashToken('abd'));
    });

    it('does not contain the original value', () => {
        const raw = 'a-secret-refresh-token-value';
        expect(hashToken(raw)).not.toContain(raw);
        expect(hashToken(raw)).toHaveLength(64); // sha256 hex
    });
});
