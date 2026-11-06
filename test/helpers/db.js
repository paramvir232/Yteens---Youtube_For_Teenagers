/**
 * Test database lifecycle.
 *
 * Every run connects to a UNIQUELY NAMED database on the local mongod and drops it
 * afterwards, so runs cannot see each other's data and a crashed run leaves nothing
 * behind that the next one has to clean up.
 *
 * assertLocal() is the most important function in the test suite and is not optional.
 * The suite calls dropDatabase(). If MONGODB_URI_TEST were ever pointed at Atlas - by a
 * copy-pasted .env, a CI variable, or someone reusing MONGODB_URI because the tests
 * "needed a database" - that single call would destroy production. Eight lines of
 * checking removes the possibility entirely, which is worth far more than the
 * convenience of allowing a remote test database.
 */
const mongoose = require('mongoose');

const { mongoUriLocality } = require('../../config/mongoUri');

/**
 * Throw unless `uri` points at a mongod on this machine.
 *
 * The host parsing lives in config/mongoUri.js, shared with scripts/ensureIndexes.js -
 * the other place that must not be pointed at production by accident.
 */
function assertLocal(uri) {
  if (typeof uri !== 'string' || !uri) {
    throw new Error('MONGODB_URI_TEST is not set. Refusing to run tests.');
  }
  const { local, reason } = mongoUriLocality(uri);
  if (!local) {
    throw new Error(
      `MONGODB_URI_TEST cannot be used: ${reason}. The test suite drops its database ` +
      'and will only ever run against a local mongod.'
    );
  }
}

function testDbName() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `yteens_test_${process.pid}_${Date.now()}_${rand}`;
}

async function connectTestDB() {
  const uri = process.env.MONGODB_URI_TEST;
  assertLocal(uri);
  await mongoose.connect(uri, { dbName: testDbName(), autoIndex: true });
  return mongoose.connection;
}

/**
 * Empty every collection without dropping the database, so indexes built once at connect
 * time survive between tests. Called in afterEach rather than beforeEach: clearing after
 * means a failing test leaves no residue for the next one to trip over.
 */
async function clearCollections() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

async function dropTestDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

module.exports = { assertLocal, connectTestDB, clearCollections, dropTestDB, testDbName };
