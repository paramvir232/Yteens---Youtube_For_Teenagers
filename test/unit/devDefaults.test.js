const { devDefault, numberFromEnv, __resetAnnounced } = require('../../config/devDefaults');

/**
 * Localhost defaults, and the guard that keeps them out of production.
 *
 * The guard is the only reason this helper is safe to use. A default that applied
 * everywhere would mean a deploy with a missing variable quietly talks to localhost
 * instead of failing - which is the same class of bug these defaults exist to remove,
 * just pointed the other way.
 */

describe('devDefault', () => {
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    __resetAnnounced();
    delete process.env.TEST_ONLY_VAR;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = original;
    delete process.env.TEST_ONLY_VAR;
    jest.restoreAllMocks();
  });

  it('supplies the default while developing', () => {
    process.env.NODE_ENV = 'development';
    expect(devDefault('TEST_ONLY_VAR', 'http://localhost:8000')).toBe('http://localhost:8000');
  });

  it.each(['production', 'test', 'staging', undefined])(
    'supplies NOTHING when NODE_ENV is %s',
    (env) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;

      // undefined, so requireEnv still throws and the deploy still fails loudly.
      expect(devDefault('TEST_ONLY_VAR', 'http://localhost:8000')).toBeUndefined();
    }
  );

  it('always prefers a real value over the default', () => {
    process.env.NODE_ENV = 'development';
    process.env.TEST_ONLY_VAR = 'mongodb://elsewhere:27017/real';
    expect(devDefault('TEST_ONLY_VAR', 'mongodb://localhost:27017/yteens_dev'))
      .toBe('mongodb://elsewhere:27017/real');
  });

  it('treats a blank value as unset', () => {
    // `MONGODB_URI_LOCAL=` is the usual way this goes wrong: present, and useless.
    process.env.NODE_ENV = 'development';
    process.env.TEST_ONLY_VAR = '   ';
    expect(devDefault('TEST_ONLY_VAR', 'fallback')).toBe('fallback');
  });

  it('announces each substitution exactly once', () => {
    // A default nobody can see is how you debug the wrong database for an hour. Once,
    // though - not on every request.
    process.env.NODE_ENV = 'development';
    devDefault('TEST_ONLY_VAR', 'x');
    devDefault('TEST_ONLY_VAR', 'x');
    devDefault('TEST_ONLY_VAR', 'x');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log.mock.calls[0][0]).toContain('TEST_ONLY_VAR');
  });
});

describe('numberFromEnv', () => {
  beforeEach(() => {
    delete process.env.TEST_ONLY_NUM;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.TEST_ONLY_NUM;
    jest.restoreAllMocks();
  });

  it('falls back when unset or blank', () => {
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(30);
    process.env.TEST_ONLY_NUM = '';
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(30);
  });

  it('falls back on a value that is not a number', () => {
    // The bug this replaces: Number(process.env.X || 30) returns NaN for 'thirty',
    // because the || never fires. A NaN rate limit or token lifetime then fails
    // somewhere far away from the typo.
    process.env.TEST_ONLY_NUM = 'thirty';
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(30);
    expect(console.warn).toHaveBeenCalled();
  });

  it('uses a real number, including zero', () => {
    process.env.TEST_ONLY_NUM = '7';
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(7);
    process.env.TEST_ONLY_NUM = '0';
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(0);
  });

  it('rejects Infinity rather than passing it to a rate limiter', () => {
    process.env.TEST_ONLY_NUM = 'Infinity';
    expect(numberFromEnv('TEST_ONLY_NUM', 30)).toBe(30);
  });
});
