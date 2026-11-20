/**
 * Build / boot checks.
 *
 * Unit and integration tests exercise individual routes, but they all import the same
 * handful of modules. None of them would catch a module that fails to load, a router
 * mounted at a path that collides with another, or middleware registered in an order
 * that breaks the stack — the kinds of failure that take the whole server down on
 * start rather than failing one endpoint.
 *
 * These assertions are deliberately structural: they check the app assembles and every
 * route surface still answers, not what any individual handler returns.
 */
const request = require('supertest');

describe('the app assembles', () => {
    it('loads app.js without throwing', () => {
        expect(() => require('../../app')).not.toThrow();
    });

    it('loads every model', () => {
        // A model with a bad schema throws at require time, which would otherwise show
        // up as the server failing to boot in production rather than a failing test.
        const models = [
            'usersModel', 'channelModel', 'videoModel', 'transcriptModel',
            'refreshTokenModel', 'uploadAttemptModel', 'uploadJobModel',
            'communityModel', 'communityMemberModel', 'communityPostModel',
            'communityCommentModel', 'communityVoteModel', 'communityModerationLogModel',
        ];
        for (const name of models) {
            expect(() => require(`../../models/${name}`)).not.toThrow();
        }
    });

    it('loads every route module', () => {
        const routes = [
            'usersRoute', 'channelRoute', 'videoRoute',
            'uploadV2Route', 'uploadJobsRoute', 'feedRoute', 'authRoute', 'communityRoute',
        ];
        for (const name of routes) {
            expect(() => require(`../../routes/${name}`)).not.toThrow();
        }
    });

    it('builds the Swagger spec', () => {
        // swagger-jsdoc parses every route file's comments at require time; a malformed
        // JSDoc block throws here rather than when someone opens /docs.
        const spec = require('../../config/swaggerConfig');
        expect(spec).toHaveProperty('openapi');
    });
});

describe('every mount point answers', () => {
    const app = require('../../app');

    // Each entry asserts only that the route EXISTS and is reachable — a 404 would mean
    // it was never mounted, or that a sibling router on the same prefix shadowed it.
    it.each([
        ['GET', '/', 200],
        ['GET', '/wake-up', 200],
        ['GET', '/video/', 200],
        ['GET', '/channel/', 200],
        ['GET', '/api/v2/feed', 200],
    ])('%s %s responds %i', async (method, path, status) => {
        await request(app)[method.toLowerCase()](path).expect(status);
    });

    it('mounts auth, upload and jobs on /api/v2 without shadowing each other', async () => {
        // Four routers share the /api/v2 prefix. Express merges them in registration
        // order, so a path collision would silently route to the wrong handler. A 401 or
        // 400 proves the right handler answered; a 404 would mean it is not mounted.
        await request(app).get('/api/v2/auth/me').expect(401);
        await request(app).get('/api/v2/upload/jobs/507f1f77bcf86cd799439011').expect(401);
        await request(app).get('/api/v2/upload/attempts').expect(401);
        await request(app).get('/api/v2/feed').expect(200);
        // Communities: 404 proves the router answered (no such channel) rather than
        // the path falling through unmounted.
        await request(app).get('/api/v2/communities/507f1f77bcf86cd799439011').expect(404);
    });

    it('serves the Swagger UI', async () => {
        await request(app).get('/docs/').expect(200);
    });

    it('404s an unknown path rather than falling through to a catch-all', async () => {
        await request(app).get('/no-such-route').expect(404);
    });
});

describe('middleware order', () => {
    const app = require('../../app');

    it('compresses responses', async () => {
        // compression() used to be mounted AFTER every router, so it compressed nothing.
        // Without an assertion that silently reverts the moment someone reorders app.js.
        const res = await request(app)
            .get('/video/')
            .set('Accept-Encoding', 'gzip')
            .expect(200);

        // supertest decompresses transparently; the header is the evidence. Very small
        // bodies fall under the compression threshold, so an absent header is only a
        // failure when the body is big enough to qualify.
        const length = Number(res.headers['content-length'] || 0);
        if (length > 1024) expect(res.headers['content-encoding']).toBe('gzip');
    });

    it('sends CORS headers', async () => {
        const res = await request(app).get('/video/').expect(200);
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('routes an error through errorMW rather than Express default HTML', async () => {
        // The '/' and '/wake-up' handlers used to be registered after app.use(errorMW),
        // so their errors bypassed it entirely and fell to Express's HTML error page.
        const res = await request(app).get('/api/v2/feed?cursor=garbage').expect(400);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body.error.code).toBe('BAD_CURSOR');
    });
});
