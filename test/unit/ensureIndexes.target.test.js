/**
 * The index script must say where it is writing, and refuse a remote server by default.
 *
 * The failure this prevents is quiet rather than loud. resolveMongoUri() in development
 * is `MONGODB_URI_LOCAL || MONGODB_URI`, so an unset MONGODB_URI_LOCAL does not error -
 * it silently resolves to the production cluster, and `npm run ensure-indexes` builds
 * indexes there while the operator believes they are working locally. Nothing is
 * destroyed, but it is still I/O against a live database that nobody asked for.
 */
const { confirmTarget } = require('../../scripts/ensureIndexes');

describe('confirmTarget', () => {
  let logged;
  beforeEach(() => {
    logged = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));
  });
  afterEach(() => jest.restoreAllMocks());

  it('accepts a local mongod and names it', () => {
    expect(() => confirmTarget('mongodb://localhost:27017/yteens', [])).not.toThrow();
    expect(logged.join('\n')).toContain('localhost:27017');
  });

  it('accepts 127.0.0.1 as well', () => {
    expect(() => confirmTarget('mongodb://127.0.0.1:27017/yteens', [])).not.toThrow();
  });

  it('refuses an Atlas URI', () => {
    expect(() => confirmTarget('mongodb+srv://u:p@c.mongodb.net/yteens', []))
      .toThrow(/hosted cluster/);
  });

  it('refuses a remote host that is not Atlas', () => {
    expect(() => confirmTarget('mongodb://db.example.com:27017/yteens', []))
      .toThrow(/not this machine/);
  });

  it('allows a remote server when the caller passes --allow-remote', () => {
    // Deliberately possible: the script does have a legitimate production use. It just
    // must not be the default, and it must not happen without someone typing it.
    expect(() => confirmTarget('mongodb+srv://u:p@c.mongodb.net/yteens', ['--allow-remote']))
      .not.toThrow();
    expect(logged.join('\n')).toContain('REMOTE');
  });

  it('never prints credentials, in either the log line or the refusal', () => {
    confirmTarget('mongodb://admin:hunter2@localhost:27017/yteens', []);
    expect(logged.join('\n')).not.toContain('hunter2');

    try {
      confirmTarget('mongodb://admin:hunter2@db.example.com:27017/yteens', []);
      throw new Error('should have refused');
    } catch (err) {
      expect(err.message).not.toContain('hunter2');
      expect(err.message).toContain('<credentials>');
    }
  });

  it('points at the likely cause when running in development', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      expect(() => confirmTarget('mongodb+srv://u:p@c.mongodb.net/x', []))
        .toThrow(/MONGODB_URI_LOCAL/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
