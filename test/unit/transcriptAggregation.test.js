/**
 * How a transcript's chunks add up to one verdict.
 *
 * The transcript stage used to reject when ANY chunk tripped the text service's own flag -
 * the same shape as the old one-frame rule, and it fails the same way. A 9-minute video is
 * about ten chunks of ASR output scored with no surrounding context, so any per-chunk error
 * rate gets multiplied by ten. A study-tips video was rejected with a top toxicity of 0.69
 * across its ten chunks, which is not evidence of anything.
 *
 * The replacement has two halves, and the split is the whole design:
 *
 *   - GENERAL labels (toxicity, insult, obscene) need a FRACTION of chunks. One noisy
 *     chunk out of ten cannot sink a long video.
 *   - SEVERE labels (severe_toxicity, threat, identity_attack) reject on their own chunk,
 *     at a lower bar. One passage containing a threat is not noise.
 *
 * NOTE: unlike the image thresholds these numbers are NOT backed by a labelled evaluation -
 * moderation-eval covers the image axes only. They are a stated policy. What these tests
 * pin is the SHAPE of the rule, which is what was actually broken.
 */

const path = require('path');

const TEXT = path.join(__dirname, '..', '..', 'services', 'textModeration.js');
const CLIENTS = path.join(__dirname, '..', '..', 'services', 'moderationClients.js');

/** Loads textModeration with moderateText returning the given per-chunk scores in order. */
const withChunkScores = (chunkScores) => {
  jest.resetModules();
  let i = 0;
  jest.doMock(CLIENTS, () => ({
    moderateText: jest.fn(async () => {
      const scores = chunkScores[Math.min(i, chunkScores.length - 1)];
      i += 1;
      // `safe` mirrors the service's own ~0.5 bar, which we deliberately ignore.
      return { safe: Math.max(...Object.values(scores)) < 0.5, scores };
    }),
    moderateImage: jest.fn(),
    requestFrames: jest.fn(),
    requestTranscript: jest.fn(),
    TIMEOUTS: { text: 1 }
  }));
  return require(TEXT);
};

const clean = { toxicity: 0.02, severe_toxicity: 0, obscene: 0.01, threat: 0, insult: 0.01, identity_attack: 0 };
const borderline = { ...clean, toxicity: 0.69, obscene: 0.41, insult: 0.32 };
const toxic = { ...clean, toxicity: 0.95, insult: 0.9, obscene: 0.8 };
const threatening = { ...clean, toxicity: 0.4, threat: 0.8 };

describe('transcript chunk flags', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL }; jest.resetModules(); });

  it('does not flag the 0.69 chunk that rejected a real video', async () => {
    const mod = withChunkScores([borderline]);
    const v = await mod.moderateLongText('some words');

    expect(v.flaggedChunks).toBe(0);
    expect(v.safe).toBe(true);
  });

  it('flags a clearly toxic chunk', async () => {
    const mod = withChunkScores([toxic]);
    const v = await mod.moderateLongText('some words');

    expect(v.flaggedChunks).toBe(1);
    expect(v.severeChunks).toBe(0);
    expect(v.safe).toBe(false);
  });

  it('marks a threat as SEVERE, at the lower bar', async () => {
    // 0.8 threat is below the 0.7 general bar on toxicity (0.4) but above the 0.5 severe
    // bar - the whole point of having two.
    const mod = withChunkScores([threatening]);
    const v = await mod.moderateLongText('some words');

    expect(v.severeChunks).toBe(1);
    expect(v.safe).toBe(false);
  });

  it('keeps `safe` as any-chunk, which is right for a short post', async () => {
    // Community posts and comments are usually one chunk, so that chunk IS the evidence -
    // the same reason a thumbnail is judged alone. They read `safe`, not the counts.
    const mod = withChunkScores([toxic]);
    const v = await mod.moderateLongText('a short post');

    expect(v.chunks).toBe(1);
    expect(v.safe).toBe(false);
  });

  it('honours its tuning variables', async () => {
    process.env.TEXT_TOXICITY_THRESHOLD = '0.6';
    const mod = withChunkScores([borderline]);
    const v = await mod.moderateLongText('some words');

    expect(v.flaggedChunks).toBe(1);
  });
});

describe('the transcript stage reads the counts, not the flag', () => {
  const fs = require('fs');
  const PIPELINE = path.join(__dirname, '..', '..', 'services', 'moderationPipeline.js');

  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*/g, '$1');

  it('does not reject on transcriptVerdict.safe', () => {
    const code = stripComments(fs.readFileSync(PIPELINE, 'utf8'));

    // The exact line that caused the bug.
    expect(code).not.toMatch(/if\s*\(\s*!\s*transcriptVerdict\.safe\s*\)/);
    expect(code).toMatch(/severeChunks/);
    expect(code).toMatch(/flaggedChunks/);
  });

  it('applies a floor so a short transcript is not judged on one chunk', () => {
    const code = stripComments(fs.readFileSync(PIPELINE, 'utf8'));
    expect(code).toMatch(/TRANSCRIPT_MIN_FLAGGED/);
  });
});
