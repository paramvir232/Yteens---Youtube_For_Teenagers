/**
 * Guards the guard.
 *
 * assertLocal is what stands between `npm test` and a dropDatabase() against production.
 * It is eight lines of string handling, which is exactly the kind of code that quietly
 * stops working - so the cases that must throw are pinned here, including the ones with
 * credentials or replica-set hosts in the URI where naive parsing would find
 * "localhost" somewhere in the string and wave it through.
 */
const { assertLocal } = require('../helpers/db');

describe('assertLocal', () => {
  it.each([
    'mongodb://localhost:27017',
    'mongodb://127.0.0.1:27017',
    'mongodb://localhost:27017/yteens_dev',
    'mongodb://user:pass@127.0.0.1:27017/db',
    'mongodb://localhost:27017,localhost:27018/db?replicaSet=rs0',
    'mongodb://[::1]:27017',
  ])('accepts the local URI %s', (uri) => {
    expect(() => assertLocal(uri)).not.toThrow();
  });

  it.each([
    ['a hosted Atlas cluster', 'mongodb+srv://user:pass@cluster0.abcde.mongodb.net/yteens'],
    ['a remote host', 'mongodb://db.example.com:27017/yteens'],
    ['an IP that is not loopback', 'mongodb://10.0.0.5:27017/yteens'],
    ['a remote host in a replica set', 'mongodb://localhost:27017,db.example.com:27017/x'],
    ['a non-mongo scheme', 'postgres://localhost:5432/yteens'],
  ])('rejects %s', (_label, uri) => {
    expect(() => assertLocal(uri)).toThrow();
  });

  it('rejects a username that merely contains a local-looking hostname', () => {
    // The '@' splits credentials from the host; taking the first match for "localhost"
    // anywhere in the string would accept this.
    expect(() => assertLocal('mongodb://localhost:pw@db.example.com:27017/x')).toThrow();
  });

  it.each([undefined, null, ''])('rejects a missing URI (%s)', (uri) => {
    expect(() => assertLocal(uri)).toThrow(/not set/i);
  });
});
