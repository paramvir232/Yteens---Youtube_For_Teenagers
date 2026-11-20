#!/usr/bin/env node
/**
 * Build indexes deliberately, rather than letting Mongoose do it on every process start.
 *
 *     npm run ensure-indexes                      # local mongod only
 *     npm run ensure-indexes -- --allow-remote     # a deployed cluster, on purpose
 *
 * It prints the server it is about to write to and refuses a remote one without the
 * flag, because NODE_ENV=development falls back to MONGODB_URI when MONGODB_URI_LOCAL
 * is unset - so the quiet failure is running this against production while believing
 * you are local.
 *
 * Why this file exists at all: config/db.js sets autoIndex:false, because with Mongoose's
 * default of true, declaring an index on an existing schema means the next production
 * deploy issues createIndex against the live collection as a side effect of booting. For
 * a project whose first constraint is "no existing data is affected", index creation
 * needs to be something a person runs on purpose and watches.
 *
 * The distinction that matters here:
 *
 *   createIndex()  - additive. Creates what is missing, leaves everything else alone.
 *                    Safe on existing collections. Used for videos/channels/users.
 *   syncIndexes()  - DROPS any index not declared in the schema, then creates the rest.
 *                    Convenient, and catastrophic if pointed at a collection whose
 *                    indexes were created outside Mongoose. Used ONLY for collections
 *                    this project created, where the schema is the whole truth.
 *
 * Index builds on a populated collection are background operations in modern MongoDB,
 * but they still consume I/O. Run this during a quiet period on production.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, resolveMongoUri } = require('../config/db');
const { mongoUriLocality } = require('../config/mongoUri');

// Indexes on PRE-EXISTING collections. createIndex only - never syncIndexes.
const EXISTING_COLLECTION_INDEXES = [
  // Phase 1: the paginated feed filtered by tag, sorted by _id descending.
  // The unfiltered feed needs no index - the default _id_ index already serves it.
  { collection: 'videos', keys: { tags: 1, _id: -1 }, options: { name: 'feed_tag_id' } },
  // Phase 1: a channel's own videos, same sort.
  { collection: 'videos', keys: { channel: 1, _id: -1 }, options: { name: 'feed_channel_id' } },
];

// Models created by this project. These are safe to syncIndexes, and are discovered
// from the models directory as phases add them.
const NEW_MODEL_FILES = [
  '../models/refreshTokenModel',
  '../models/uploadAttemptModel',
  '../models/uploadJobModel',
  '../models/communityModel',
  '../models/communityMemberModel',
  '../models/communityPostModel',
  '../models/communityCommentModel',
  '../models/communityVoteModel',
  '../models/communityModerationLogModel',
];

/**
 * Say out loud which server is about to be written to, and refuse a remote one unless
 * the caller said so on the command line.
 *
 * This matters because of how resolveMongoUri() falls back: in development it is
 * `MONGODB_URI_LOCAL || MONGODB_URI`. Forget to set MONGODB_URI_LOCAL and
 * `npm run ensure-indexes` quietly builds indexes on the production cluster instead of
 * the local one, having printed a line that looked right. Index builds are additive and
 * nothing is destroyed - but they consume I/O on a live database, and "I ran a local
 * script" should never mean "I touched production".
 */
function confirmTarget(uri, argv) {
  const redacted = uri.replace(/\/\/[^@]*@/, '//<credentials>@');
  const { local, reason } = mongoUriLocality(uri);

  if (local) {
    console.log(`Target: ${redacted} (local)`);
    return;
  }
  if (argv.includes('--allow-remote')) {
    console.log(`Target: ${redacted} (REMOTE, allowed by --allow-remote)`);
    return;
  }

  throw new Error(
    `Refusing to build indexes against ${redacted}: ${reason}.\n` +
    (process.env.NODE_ENV === 'development'
      ? 'NODE_ENV=development resolves MONGODB_URI_LOCAL first and falls back to ' +
        'MONGODB_URI, so this is most likely an unset MONGODB_URI_LOCAL rather than a ' +
        'database you meant to touch. Set it in .env.\n'
      : '') +
    'If this really is the deployment you meant, re-run with --allow-remote.'
  );
}

async function main() {
  const uri = resolveMongoUri();
  confirmTarget(uri, process.argv.slice(2));
  await connectDB();

  for (const { collection, keys, options } of EXISTING_COLLECTION_INDEXES) {
    const name = await mongoose.connection.db.collection(collection).createIndex(keys, options);
    console.log(`  ${collection}: ${name}`);
  }

  for (const file of NEW_MODEL_FILES) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const Model = require(file);
    await Model.syncIndexes();
    console.log(`  ${Model.collection.collectionName}: synced`);
  }

  console.log('\nDone. Existing collections got createIndex (additive); new models were synced.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Index creation failed:', err.message);
    process.exit(1);
  });
}

module.exports = { confirmTarget };
