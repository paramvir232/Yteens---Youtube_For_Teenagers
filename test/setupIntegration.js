/**
 * Setup for integration tests: a real local mongod, plus the network block.
 *
 * Each test FILE gets its own uniquely named database (connectTestDB runs per file under
 * Jest's module isolation) and drops it afterwards, so runs never see each other's data
 * and a crashed run leaves nothing for the next one to trip over.
 *
 * Collections are cleared in afterEach rather than beforeEach: clearing after means a
 * failing test leaves no residue, and the database is already empty when the next file
 * starts.
 */
require('dotenv').config();
require('./helpers/noNetwork');

const { connectTestDB, clearCollections, dropTestDB } = require('./helpers/db');

/**
 * Deployment toggles must not leak in from .env.
 *
 * LEGACY_ACTOR_FALLBACK re-opens the pre-token path, where a request's `channelId` body
 * field is trusted as proof of identity. It exists as a one-variable rollback, not as a
 * setting a test run should inherit: with it set in a developer's .env, every "a write
 * without a token answers 401" assertion silently flips, and the obvious way to make
 * the suite green again is to set the variable permanently - which is the hole.
 *
 * Forced off here so the default is what the tests describe. The test that proves the
 * rollback still works sets it explicitly and restores it in a finally.
 *
 * SET to 'false' rather than deleted: config/cloudinary.js calls dotenv.config() again
 * when the app is imported, and dotenv will happily set a variable that is absent - it
 * only declines to OVERRIDE one that is present. Deleting it here just hands .env a
 * second chance.
 */
process.env.LEGACY_ACTOR_FALLBACK = 'false';

// The suite makes hundreds of writes from 127.0.0.1. With the production ceiling the
// later ones become 429s, which surface as "permission denied" style failures that have
// nothing to do with what is being tested. Tests that care about throttling set their
// own limit.
process.env.COMMUNITY_WRITE_LIMIT = process.env.COMMUNITY_WRITE_LIMIT || '100000';

jest.setTimeout(20000);

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await dropTestDB();
});
