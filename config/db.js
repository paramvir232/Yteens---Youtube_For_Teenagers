/**
 * Mongo connection, with the URI chosen by environment rather than hardcoded.
 *
 * Three separate variables exist on purpose, so that running tests or developing
 * locally cannot possibly touch production data:
 *
 *   NODE_ENV=test        -> MONGODB_URI_TEST   (required; throws if missing)
 *   NODE_ENV=development -> MONGODB_URI_LOCAL, falling back to MONGODB_URI
 *   anything else        -> MONGODB_URI
 *
 * autoIndex defaults to FALSE here, which is the opposite of Mongoose's default, and it
 * is the single most important line in this file. With autoIndex on, the moment anyone
 * declares an index on an existing schema, every process start - including the first
 * production deploy - issues createIndex against the live collection. That is an
 * operation on existing data, which this project has ruled out. Indexes are instead
 * built deliberately by scripts/ensureIndexes.js. Set MONGO_AUTO_INDEX=true locally and
 * in tests, where building them automatically is convenient and harmless.
 */
const mongoose = require('mongoose');
const { devDefault } = require('./devDefaults');

function resolveMongoUri() {
  const env = process.env.NODE_ENV;

  if (env === 'test') {
    const uri = process.env.MONGODB_URI_TEST;
    if (!uri) {
      throw new Error(
        'MONGODB_URI_TEST is not set. Tests refuse to run without an explicit test ' +
        'database, so that they can never be pointed at production by accident.'
      );
    }
    return uri;
  }

  if (env === 'development') {
    // The dev default matters more here than anywhere else: without it an unset
    // MONGODB_URI_LOCAL falls through to MONGODB_URI, so "running locally" silently
    // means reading and writing production.
    return devDefault('MONGODB_URI_LOCAL', 'mongodb://localhost:27017/yteens_dev')
      || process.env.MONGODB_URI;
  }

  return process.env.MONGODB_URI;
}

async function connectDB(options = {}) {
  const uri = options.uri || resolveMongoUri();
  if (!uri) throw new Error('No Mongo URI resolved. Check your .env file.');

  await mongoose.connect(uri, {
    dbName: options.dbName,
    autoIndex: process.env.MONGO_AUTO_INDEX === 'true',
  });

  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB, resolveMongoUri };
