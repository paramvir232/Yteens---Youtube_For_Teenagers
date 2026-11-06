/**
 * One bar for every image surface.
 *
 * The thumbnail, the video frames and community post images are three separate decisions
 * in three files, and they drifted: frames had been re-thresholded to our own bar while
 * the thumbnail and community images still trusted the service's `safe` flag, which sits
 * at roughly 0.3 with an 0.181 false-positive rate.
 *
 * That is not a tidiness point. A 9-minute video whose every frame passed was rejected on
 * its thumbnail - a screenshot of an exam timetable - because the thumbnail was being
 * judged on a looser bar than everything else. The strictest surface was the one nobody
 * had tuned.
 *
 * What the default cannot do is covered in services/imageModeration.js: at 0.7 the check
 * catches 1 of 20 genuinely violent images, because the score does not separate violent
 * from safe at all (worst violent 0.752, worst safe 0.956, 17 safe images above the worst
 * violent one). These tests pin the consistency, not the efficacy.
 */

const path = require('path');

const MODULE = path.join(__dirname, '..', '..', 'services', 'imageModeration.js');

const verdict = (violence, extra = {}) => ({
  safe: violence < 0.3,
  nsfw_score: 0.01,
  violence_score: violence,
  reason: violence < 0.3 ? null : 'violent or disturbing image detected',
  ...extra
});

describe('image moderation bar', () => {
  const ORIGINAL = { ...process.env };
  let mod;

  beforeEach(() => {
    jest.resetModules();
    mod = require(MODULE);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
  });

  it('defaults to 0.7, the bar chosen so safe content is not rejected', () => {
    expect(mod.IMAGE_VIOLENCE_THRESHOLD()).toBeCloseTo(0.7);
  });

  it('passes an image the service itself called unsafe below our bar', () => {
    // 0.39 is what a generated SMPTE colour-bar pattern scored. The service says unsafe;
    // we do not.
    const v = verdict(0.39);
    expect(v.safe).toBe(false);
    expect(mod.isImageUnsafe(v)).toBe(false);
  });

  it('passes the highest score any genuinely violent image reached, minus a hair', () => {
    // The worst violent image in the labelled set scored 0.752, so 0.7 is only just below
    // the top of the violent range - which is the whole problem, recorded here.
    expect(mod.isImageUnsafe(verdict(0.69))).toBe(false);
    expect(mod.isImageUnsafe(verdict(0.752))).toBe(true);
  });

  it('still blocks a confident nsfw verdict', () => {
    // The axis is weak (AUC 0.449), but dropping it would unblock NSFW imagery everywhere
    // on a platform for 10-20 year olds. A 0.5 bar costs nothing: in the labelled set no
    // image scores above 0.1 on this axis, so it rejects none of them.
    expect(mod.isImageUnsafe(verdict(0.0, { nsfw_score: 0.99, safe: false }))).toBe(true);
  });

  it('does not let a low nsfw score reject anything', () => {
    expect(mod.isImageUnsafe(verdict(0.0, { nsfw_score: 0.1 }))).toBe(false);
  });

  it('treats a fetch or decode failure as not-unsafe, and says so separately', () => {
    const broken = { safe: false, nsfw_score: 0, violence_score: 0, reason: 'image processing error' };
    expect(mod.isProcessingError(broken)).toBe(true);
    expect(mod.isImageUnsafe(broken)).toBe(false);
  });

  it('is tunable without a redeploy', () => {
    process.env.IMAGE_VIOLENCE_THRESHOLD = '0.4';
    jest.resetModules();
    const tuned = require(MODULE);
    expect(tuned.isImageUnsafe(verdict(0.49))).toBe(true);
  });

  it('falls back to the default when given nonsense', () => {
    process.env.IMAGE_VIOLENCE_THRESHOLD = 'not-a-number';
    jest.resetModules();
    const tuned = require(MODULE);
    expect(tuned.IMAGE_VIOLENCE_THRESHOLD()).toBeCloseTo(0.7);
  });
});

describe('every image surface uses that one bar', () => {
  /**
   * Asserted against the source rather than by driving each route, because the failure
   * being guarded is precisely that one call site keeps its own rule. A grep-style check
   * catches a new surface added later that reaches for `verdict.safe` again.
   */
  const fs = require('fs');
  const SERVICES = path.join(__dirname, '..', '..', 'services');

  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*/g, '$1');

  it.each([
    ['moderationPipeline.js', 'the thumbnail and the video frames'],
    ['communityModeration.js', 'community post images']
  ])('%s decides with isImageUnsafe, not the service flag', (file) => {
    const code = stripComments(fs.readFileSync(path.join(SERVICES, file), 'utf8'));

    expect(code).toMatch(/isImageUnsafe\(/);
    // The service's own flag must not be what any decision turns on.
    expect(code).not.toMatch(/\.safe\s*===\s*false/);
  });
});
