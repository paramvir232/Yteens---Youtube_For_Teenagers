const { verdictFor } = require('../../scripts/moderationStub');

/**
 * The stub's verdict rule.
 *
 * Driven by the content rather than a flag, so one running stub can serve an accept and
 * a reject in the same test run without a restart. That property is what makes the
 * rejection paths testable at all: against the real Spaces a rejection means waiting out
 * a cold start and hoping the model agrees with you.
 */
describe('verdictFor', () => {
  it('passes ordinary content', () => {
    expect(verdictFor('a short clip from my holiday')).toBe('safe');
  });

  it.each([
    ['REJECT this please', 'unsafe'],
    ['make it SLOW', 'slow'],
    ['BOOM', 'error'],
  ])('%s -> %s', (text, expected) => {
    expect(verdictFor(text)).toBe(expected);
  });

  it('matches regardless of case, so a URL path works too', () => {
    // The image call passes Cloudinary URLs, where the marker lands in the filename.
    expect(verdictFor('https://res.cloudinary.com/demo/reject_frame_03.jpg')).toBe('unsafe');
  });

  it('treats empty and missing input as safe', () => {
    // A missing ?text= must not look like a rejection - that would make every
    // malformed request look like a moderation verdict.
    expect(verdictFor('')).toBe('safe');
    expect(verdictFor(undefined)).toBe('safe');
    expect(verdictFor(null)).toBe('safe');
  });

  it('prefers the most disruptive marker when several are present', () => {
    // Order matters so a test asking for a failure gets one, rather than a rejection
    // that happens to also contain the word.
    expect(verdictFor('BOOM and REJECT and SLOW')).toBe('error');
    expect(verdictFor('REJECT and SLOW')).toBe('slow');
  });
});
