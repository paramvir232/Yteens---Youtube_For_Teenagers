#!/usr/bin/env node
/**
 * Is this machine configured to serve a real, moderated upload?
 *
 *     npm run preflight           # configuration only, instant
 *     npm run preflight -- --ping # also contact the three services
 *
 * Why this exists: a moderated upload needs Cloudinary AND a transcript service AND two
 * moderation services. The pipeline fails CLOSED, so one missing URL does not degrade
 * the feature - every upload is rejected and the Cloudinary asset is destroyed. Finding
 * that out after pushing a 9MB file through is a slow way to learn that a variable is
 * unset.
 *
 * It prints names and PRESENT/MISSING only. It never prints a value, so its output is
 * safe to paste into a chat or an issue.
 */
require('dotenv').config({ quiet: true });

const GROUPS = [
  {
    name: 'Core',
    note: 'the server will not start without these',
    vars: ['JWT_ACCESS_SECRET'],
  },
  {
    name: 'Database',
    note: 'NODE_ENV=development uses MONGODB_URI_LOCAL, falling back to MONGODB_URI',
    vars: ['MONGODB_URI'],
    optional: ['MONGODB_URI_LOCAL', 'MONGODB_URI_TEST'],
  },
  {
    name: 'Upload (Cloudinary)',
    note: 'needed by both the legacy and the moderated route',
    vars: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  },
  {
    name: 'Moderation',
    note: 'POST /api/v2/upload rejects EVERY upload if any of these is missing',
    vars: [
      'TRANSCRIPT_SERVICE_URL',
      'TRANSCRIPT_SERVICE_API_KEY',
      'TEXT_MODERATION_URL',
      'IMAGE_MODERATION_URL',
    ],
  },
];

/** Pure: which names are set, which are not. Values never leave this function. */
function checkGroups(env, groups = GROUPS) {
  return groups.map((group) => {
    const required = group.vars.map((name) => ({
      name,
      present: Boolean(env[name] && String(env[name]).trim()),
      required: true,
    }));
    const optional = (group.optional || []).map((name) => ({
      name,
      present: Boolean(env[name] && String(env[name]).trim()),
      required: false,
    }));
    const entries = [...required, ...optional];
    return { ...group, entries, ok: required.every((e) => e.present) };
  });
}

/**
 * Pure: settings that are present and valid but dangerous.
 *
 * LEGACY_ACTOR_FALLBACK=true re-opens the pre-token path, where a request's `channelId`
 * body field is trusted as proof of identity - anyone can act as anyone by naming their
 * channel. It is a rollback switch, and it has been found left on in a working .env
 * before, which is exactly why it is checked here rather than trusted.
 */
function checkDangerous(env) {
  const warnings = [];
  if (String(env.LEGACY_ACTOR_FALLBACK).toLowerCase() === 'true') {
    warnings.push(
      'LEGACY_ACTOR_FALLBACK=true - a request body\'s channelId is accepted as proof of ' +
      'identity. Anyone can act as anyone. Set it to false unless you are mid-rollback.'
    );
  }
  if (env.NODE_ENV === 'production' && String(env.MONGO_AUTO_INDEX).toLowerCase() === 'true') {
    warnings.push(
      'MONGO_AUTO_INDEX=true in production - every process start issues createIndex ' +
      'against live collections. Use `npm run ensure-indexes` instead.'
    );
  }
  return warnings;
}

/** Reachability, not correctness: a 404 still proves something is listening. */
async function ping(url, timeoutMs = 90000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `no answer in ${timeoutMs}ms` : err.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const groups = checkGroups(process.env);
  let missing = 0;

  console.log(`\nPreflight  (NODE_ENV=${process.env.NODE_ENV || 'undefined'})\n`);

  for (const group of groups) {
    console.log(`  ${group.name}`);
    console.log(`    ${group.note}`);
    for (const entry of group.entries) {
      const mark = entry.present ? 'set    ' : (entry.required ? 'MISSING' : 'unset  ');
      if (entry.required && !entry.present) missing += 1;
      console.log(`      ${mark}  ${entry.name}`);
    }
    console.log('');
  }

  for (const warning of checkDangerous(process.env)) {
    console.log(`  WARNING  ${warning}\n`);
  }

  if (process.argv.includes('--ping')) {
    console.log('  Reachability');
    console.log('    Hugging Face Spaces sleep when idle; a cold start measured 60s+.');
    console.log('    A slow first answer here is normal, and is time an upload would also pay.\n');
    for (const name of ['TRANSCRIPT_SERVICE_URL', 'TEXT_MODERATION_URL', 'IMAGE_MODERATION_URL']) {
      const url = process.env[name];
      if (!url) {
        console.log(`      skipped  ${name} (not set)`);
        continue;
      }
      // The host only - the paths want POST bodies, and this asks "is anything there".
      const result = await ping(url);
      console.log(
        result.ok
          ? `      up       ${name}  (HTTP ${result.status}, ${result.ms}ms)`
          : `      DOWN     ${name}  (${result.error})`
      );
    }
    console.log('');
  }

  if (missing > 0) {
    console.log(`  ${missing} required value(s) missing. A moderated upload cannot succeed.\n`);
    process.exit(1);
  }
  console.log('  All required values are set.\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Preflight failed:', err.message);
    process.exit(1);
  });
}

module.exports = { checkGroups, checkDangerous };
