const { checkGroups, checkDangerous } = require('../../scripts/preflight');

/**
 * The preflight check.
 *
 * Its job is to answer "can a moderated upload possibly succeed here" before anyone
 * spends four minutes finding out. Two properties matter enough to pin:
 *
 *   1. It must never print a value. Its output gets pasted into chats and issues, and
 *      the variables it reads are Cloudinary secrets and a JWT signing key.
 *   2. It must shout about LEGACY_ACTOR_FALLBACK=true. That setting was found left on
 *      in a working .env, where it silently re-opened the impersonation hole while
 *      every route still looked protected.
 */

const GROUP = [{ name: 'T', note: 'n', vars: ['A', 'B'], optional: ['C'] }];

describe('checkGroups', () => {
  it('reports presence, never the value', () => {
    const [group] = checkGroups({ A: 'super-secret-key', B: 'x' }, GROUP);
    const serialised = JSON.stringify(group);

    expect(serialised).not.toContain('super-secret-key');
    expect(group.entries.find((e) => e.name === 'A').present).toBe(true);
  });

  it('is not satisfied by a blank or whitespace value', () => {
    // A key left as `CLOUDINARY_API_KEY=` is the common way this goes wrong, and it is
    // "set" as far as process.env is concerned.
    const [group] = checkGroups({ A: '', B: '   ' }, GROUP);
    expect(group.entries.filter((e) => e.present)).toHaveLength(0);
    expect(group.ok).toBe(false);
  });

  it('does not fail a group over an optional value', () => {
    const [group] = checkGroups({ A: '1', B: '1' }, GROUP);
    expect(group.ok).toBe(true);
    expect(group.entries.find((e) => e.name === 'C').required).toBe(false);
  });

  it('fails the group when a required value is missing', () => {
    const [group] = checkGroups({ A: '1', C: '1' }, GROUP);
    expect(group.ok).toBe(false);
  });

  it('covers every service the moderated upload needs', () => {
    // Guards against a new dependency being added to the pipeline without being added
    // here - the whole point is that one missing URL rejects every upload.
    const names = checkGroups({}).flatMap((g) => g.entries.map((e) => e.name));
    for (const required of [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
      'TRANSCRIPT_SERVICE_URL',
      'TRANSCRIPT_SERVICE_API_KEY',
      'TEXT_MODERATION_URL',
      'IMAGE_MODERATION_URL',
      'JWT_ACCESS_SECRET',
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe('checkDangerous', () => {
  it('warns about the impersonation fallback', () => {
    expect(checkDangerous({ LEGACY_ACTOR_FALLBACK: 'true' })).toHaveLength(1);
    expect(checkDangerous({ LEGACY_ACTOR_FALLBACK: 'TRUE' })).toHaveLength(1);
  });

  it('says nothing when it is off or absent', () => {
    expect(checkDangerous({ LEGACY_ACTOR_FALLBACK: 'false' })).toHaveLength(0);
    expect(checkDangerous({})).toHaveLength(0);
  });

  it('warns about autoIndex in production only', () => {
    expect(checkDangerous({ NODE_ENV: 'production', MONGO_AUTO_INDEX: 'true' })).toHaveLength(1);
    expect(checkDangerous({ NODE_ENV: 'development', MONGO_AUTO_INDEX: 'true' })).toHaveLength(0);
  });
});
