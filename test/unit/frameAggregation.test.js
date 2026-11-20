/**
 * How frame verdicts add up to one decision.
 *
 * The rule used to be "reject on the first frame the image service calls unsafe". With a
 * measured per-frame false-positive rate of 0.181 and 30 frames sampled, that rejects
 * 1 - 0.819^30 = 99.75% of clean videos, and in practice it did: a news interview and a
 * generated SMPTE colour-bar pattern were both rejected.
 *
 * These tests pin the replacement: a per-frame threshold we own, plus a fraction of
 * frames that must clear it. The real scores measured from test.mp4 and from the colour
 * bars are used directly, so a regression here fails with the same input that found the
 * bug.
 */

const path = require('path');

const PIPELINE = path.join(__dirname, '..', '..', 'services', 'moderationPipeline.js');
const CLIENTS = path.join(__dirname, '..', '..', 'services', 'moderationClients.js');

/** Loads the pipeline with moderateImage stubbed to return the given verdicts in order. */
const withFrameScores = (verdicts) => {
  jest.resetModules();
  const calls = { count: 0 };
  jest.doMock(CLIENTS, () => ({
    requestFrames: jest.fn(),
    requestTranscript: jest.fn(),
    moderateImage: jest.fn(async () => {
      const v = verdicts[calls.count];
      calls.count += 1;
      return v;
    }),
    moderateText: jest.fn(),
    TIMEOUTS: { text: 1, image: 1, frames: 1, translate: 1 }
  }));
  const { moderateFrames } = require(PIPELINE);
  return { moderateFrames, calls };
};

/** A verdict as the real service shapes it: `safe` at its own ~0.3 operating point. */
const frame = (violence) => ({
  safe: violence < 0.3,
  nsfw_score: 0.015,
  violence_score: violence,
  reason: violence < 0.3 ? null : 'violent or disturbing image detected'
});

const urls = (n) => Array.from({ length: n }, (_, i) => `https://example.test/f${i}.jpg`);

describe('frame aggregation', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
  });

  it('accepts the real test.mp4 scores, which the old rule rejected', async () => {
    // Measured against the live service, six frames sampled across the clip. Four of the
    // six are flagged by the service's own `safe` flag; none of them is violent - it is a
    // news interview at an airport.
    const measured = [0, 0.383, 0.49, 0, 0.463, 0.596];
    const { moderateFrames } = withFrameScores(measured.map(frame));

    const verdict = await moderateFrames(urls(6));

    // 40% of 6 rounds up to 3 frames needed. Only 0.596 clears a 0.5 threshold, so the
    // video is accepted.
    //
    // `flagged` is 0 rather than 1 because the loop stops as soon as rejection has become
    // arithmetically impossible: after four frames with none flagged, the two left cannot
    // reach three. That early exit is asserted on its own below; what matters here is the
    // verdict.
    expect(verdict.needed).toBe(3);
    expect(verdict.safe).toBe(true);
  });

  it('accepts generated colour bars, which the old rule rejected', async () => {
    // An SMPTE test pattern scored 0.39: above the service's own bar, below ours.
    const { moderateFrames } = withFrameScores(Array(10).fill(frame(0.39)));

    const verdict = await moderateFrames(urls(10));

    expect(verdict.flagged).toBe(0);
    expect(verdict.safe).toBe(true);
  });

  it('rejects when a large fraction of frames clears the threshold', async () => {
    // Six of ten at 0.8 - comfortably past both the ratio and the floor.
    const scores = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.1, 0.1, 0.1, 0.1];
    const { moderateFrames } = withFrameScores(scores.map(frame));

    const verdict = await moderateFrames(urls(10));

    expect(verdict.safe).toBe(false);
    expect(verdict.flagged).toBeGreaterThanOrEqual(verdict.needed);
    expect(verdict.flaggedIndex).toBe(0);
    expect(verdict.reason).toMatch(/violent/i);
  });

  it('never rejects on a single frame, however short the video', async () => {
    // The floor matters most for short clips: with 2 frames a 40% ratio would otherwise
    // round down to 1, which is the old bug again.
    const { moderateFrames } = withFrameScores([frame(0.99), frame(0.0)]);

    const verdict = await moderateFrames(urls(2));

    expect(verdict.flagged).toBe(1);
    expect(verdict.safe).toBe(true);
  });

  it('does not let one very high score decide', async () => {
    // Deliberate: in the calibration the 0.8-1.0 bins have an observed positive rate of
    // 0.0, so a "one certain frame" override would add false rejections and catch nothing.
    const { moderateFrames } = withFrameScores([
      frame(1.0), frame(0), frame(0), frame(0), frame(0),
      frame(0), frame(0), frame(0), frame(0), frame(0)
    ]);

    const verdict = await moderateFrames(urls(10));

    expect(verdict.safe).toBe(true);
    expect(verdict.scores.violence_score).toBe(1.0);
  });

  it('counts a confident nsfw frame, and still needs a group of them', async () => {
    // The nsfw axis is weak but it is not dropped - see services/imageModeration.js. It
    // goes through the same aggregation as violence, so one such frame is not enough and
    // a video full of them is.
    const nsfwFrame = {
      safe: false,
      nsfw_score: 0.99,
      violence_score: 0.0,
      reason: 'nsfw content detected'
    };
    const one = withFrameScores([nsfwFrame, ...Array(9).fill(frame(0))]);
    expect((await one.moderateFrames(urls(10))).safe).toBe(true);

    const many = withFrameScores(Array(10).fill(nsfwFrame));
    const verdict = await many.moderateFrames(urls(10));
    expect(verdict.safe).toBe(false);
    expect(verdict.scores.nsfw_score).toBe(0.99);
  });

  it('counts a fetch or decode failure as an error, not as violence', async () => {
    // The service reports an unreachable URL as safe:false with zero scores. Treating
    // that as evidence would reject a video over a network blip.
    const verdicts = Array(10).fill({
      safe: false,
      nsfw_score: 0,
      violence_score: 0,
      reason: 'image processing error'
    });
    const { moderateFrames } = withFrameScores(verdicts);

    const verdict = await moderateFrames(urls(10));

    expect(verdict.errored).toBe(10);
    expect(verdict.flagged).toBe(0);
    expect(verdict.safe).toBe(true);
  });

  it('stops early once the answer cannot change', async () => {
    // The early exit that made rejections cheap is kept - it just needs enough frames to
    // decide now instead of one.
    const { moderateFrames, calls } = withFrameScores(Array(30).fill(frame(0.9)));

    const verdict = await moderateFrames(urls(30));

    expect(verdict.safe).toBe(false);
    // 40% of 30 is 12, so it should stop there rather than paying for all 30.
    expect(calls.count).toBe(12);
  });

  it('stops early once rejection has become impossible', async () => {
    const { moderateFrames, calls } = withFrameScores(Array(30).fill(frame(0.0)));

    const verdict = await moderateFrames(urls(30));

    expect(verdict.safe).toBe(true);
    expect(calls.count).toBeLessThan(30);
  });

  it('honours the tuning environment variables', async () => {
    process.env.IMAGE_VIOLENCE_THRESHOLD = '0.3';
    process.env.FRAME_FLAG_RATIO = '0.2';
    process.env.FRAME_MIN_FLAGGED = '2';
    const measured = [0, 0.383, 0.49, 0, 0.463, 0.596];
    const { moderateFrames } = withFrameScores(measured.map(frame));

    const verdict = await moderateFrames(urls(6));

    // Same clip, stricter settings. 20% of 6 rounds up to 2, which the floor also sets,
    // so two flagged frames are enough and the same video is now rejected - the proof
    // that the operating point is tunable without redeploying the model.
    //
    // It stops at exactly 2: the third frame (0.49) settles it, so the last two are never
    // scored.
    expect(verdict.needed).toBe(2);
    expect(verdict.flagged).toBe(2);
    expect(verdict.safe).toBe(false);
  });

  /**
   * The guarantee itself, stated independently of the current numbers.
   *
   * A single flagged frame must never reject a video, at ANY frame count - and nor must a
   * small handful. The sampler's f_min is 8 and the route caps at MAX_FRAMES, so 8..30 is
   * the range that can actually occur, but the first test walks from 1 so that lowering
   * f_min, or setting the frame service's max_frames low, cannot quietly reintroduce
   * small-group rejections.
   */
  describe('no small group can reject a video', () => {
    const counts = Array.from({ length: 30 }, (_, i) => i + 1);

    it.each(counts)('one flagged frame out of %d is not enough', async (n) => {
      // One frame at the top of the range, the rest clean.
      const verdicts = [frame(1.0), ...Array(n - 1).fill(frame(0.0))];
      const { moderateFrames } = withFrameScores(verdicts);

      const verdict = await moderateFrames(urls(n));

      expect(verdict.safe).toBe(true);
    });

    it.each(counts)('two flagged frames out of %d are not enough', async (n) => {
      const verdicts = [frame(1.0), frame(1.0), ...Array(Math.max(0, n - 2)).fill(frame(0.0))];
      const { moderateFrames } = withFrameScores(verdicts);

      const verdict = await moderateFrames(urls(n));

      expect(verdict.safe).toBe(true);
    });

    it.each([8, 10, 12, 15, 20, 26, 30])(
      'a real sample of %d frames needs at least 4 flagged, and at least 40%%',
      async (n) => {
        const { moderateFrames } = withFrameScores(Array(n).fill(frame(0.0)));

        const verdict = await moderateFrames(urls(n));

        expect(verdict.needed).toBeGreaterThanOrEqual(4);
        expect(verdict.needed / n).toBeGreaterThanOrEqual(0.4);
      }
    );
  });

  it('is safe on a video with no frames', async () => {
    const { moderateFrames } = withFrameScores([]);
    const verdict = await moderateFrames([]);
    expect(verdict.safe).toBe(true);
    expect(verdict.checked).toBe(0);
  });
});
