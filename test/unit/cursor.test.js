const mongoose = require('mongoose');
const { encodeCursor, decodeCursor } = require('../../util/cursor');

describe('cursor', () => {
  it('round-trips an ObjectId', () => {
    const id = new mongoose.Types.ObjectId();
    expect(decodeCursor(encodeCursor(id)).toString()).toBe(id.toString());
  });

  it('produces a cursor that is not the raw id', () => {
    const id = new mongoose.Types.ObjectId();
    // Opaque on purpose: a client that can read the id starts treating the cursor as
    // "the video with this id" and breaks when the encoding changes.
    expect(encodeCursor(id)).not.toBe(id.toString());
  });

  it('is URL-safe', () => {
    for (let i = 0; i < 50; i += 1) {
      const cursor = encodeCursor(new mongoose.Types.ObjectId());
      expect(cursor).toBe(encodeURIComponent(cursor));
    }
  });

  it.each([undefined, null, ''])('treats %s as "no cursor"', (value) => {
    expect(decodeCursor(value)).toBeNull();
  });

  it.each([
    ['plain text', 'not-a-cursor'],
    ['a raw id passed through unencoded', '507f1f77bcf86cd799439011'],
    ['base64 of something too short', Buffer.from('abc').toString('base64url')],
    ['base64 of a 23-char hex string', Buffer.from('507f1f77bcf86cd79943901').toString('base64url')],
    ['base64 of a 25-char hex string', Buffer.from('507f1f77bcf86cd7994390111').toString('base64url')],
    ['base64 of non-hex characters', Buffer.from('zzzzzzzzzzzzzzzzzzzzzzzz').toString('base64url')],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeCursor(value)).toThrow(/malformed/i);
  });

  it('returns null rather than a cursor for a null id', () => {
    expect(encodeCursor(null)).toBeNull();
  });
});
