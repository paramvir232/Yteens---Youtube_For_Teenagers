/**
 * Is this Mongo URI a server on this machine?
 *
 * Shared by the test harness (which calls dropDatabase) and scripts/ensureIndexes.js
 * (which writes indexes). Both need the same answer to the same question, and two
 * copies of host parsing would be two things to keep in step.
 *
 * Returns a reason rather than throwing, because the two callers want different
 * consequences: the tests refuse outright, the index script asks to be told explicitly.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * @param {unknown} uri
 * @returns {{ local: boolean, reason: string|null }} reason is null when local.
 */
function mongoUriLocality(uri) {
  if (typeof uri !== 'string' || !uri) {
    return { local: false, reason: 'no URI was given' };
  }
  // mongodb+srv:// resolves through DNS SRV records and is what Atlas hands out, so it
  // is never local however local the hostname looks.
  if (uri.startsWith('mongodb+srv://')) {
    return { local: false, reason: 'mongodb+srv:// is a hosted cluster' };
  }
  if (!uri.startsWith('mongodb://')) {
    return { local: false, reason: `it does not start with mongodb:// (got: ${uri.slice(0, 20)}...)` };
  }

  // Strip scheme, any credentials, and anything after the host section.
  const afterScheme = uri.slice('mongodb://'.length);
  const authority = afterScheme.split('/')[0].split('?')[0];
  const hostPart = authority.includes('@') ? authority.split('@').pop() : authority;

  for (const hostPort of hostPart.split(',')) {
    const host = hostPort.startsWith('[')
      ? hostPort.slice(0, hostPort.indexOf(']') + 1) // IPv6 literal
      : hostPort.split(':')[0];
    if (!LOCAL_HOSTS.has(host)) {
      return { local: false, reason: `it points at "${host}", which is not this machine` };
    }
  }

  return { local: true, reason: null };
}

module.exports = { mongoUriLocality };
