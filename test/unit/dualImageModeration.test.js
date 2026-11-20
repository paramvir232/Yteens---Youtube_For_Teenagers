/**
 * The two-model image rule (services/dualImageModeration.js).
 *
 * Per image: unsafe only when BOTH models say unsafe (each on the app bar). Either model
 * saying safe is enough to pass. A model that cannot answer is not a "safe": if the other
 * one flagged the image, the decision is unavailable rather than a guess.
 *
 * Per video: every frame goes to both models, one image per request; one frame both
 * agree on rejects. No list calls.
 */
const path = require('path');

const CLIENTS = path.join(__dirname, '..', '..', 'services', 'moderationClients.js');
const DUAL = path.join(__dirname, '..', '..', 'services', 'dualImageModeration.js');

const SAFE = { safe: true, nsfw_score: 0, violence_score: 0, reason: null };
const NSFW = { safe: false, nsfw_score: 0.95, violence_score: 0, reason: 'nsfw content detected' };
const VIOLENT_A = { safe: false, nsfw_score: 0.01, violence_score: 0.9, reason: 'violent' };
// Model A's service flag on a clean news frame: unsafe by the service, safe by our bar.
const NEWS_A = { safe: false, nsfw_score: 0.014, violence_score: 0.379, reason: 'violent' };
const PROC_ERR = { safe: false, nsfw_score: 0, violence_score: 0, reason: 'image processing error' };

/** a, b: url -> verdict | Error. bBatch: urls -> verdict | Error (defaults to worst of b). */
const load = ({ a = {}, b = {}, bBatch } = {}) => {
  jest.resetModules();
  const pick = (map, url) => {
    const v = typeof map === 'function' ? map(url) : (map[url] ?? SAFE);
    if (v instanceof Error) throw v;
    return v;
  };
  const clients = {
    moderateImage: jest.fn(async (url) => pick(a, url)),
    moderateImageB: jest.fn(async (url) => pick(b, url)),
    moderateImagesB: jest.fn(async (urls) => {
      if (bBatch) {
        const v = bBatch(urls);
        if (v instanceof Error) throw v;
        return v;
      }
      const all = urls.map((u) => pick(b, u));
      return all.find((v) => v.safe === false) || SAFE;
    }),
  };
  jest.doMock(CLIENTS, () => clients);
  return { dual: require(DUAL), clients };
};

const urls = (n) => Array.from({ length: n }, (_, i) => `f${i}`);

afterEach(() => jest.dontMock(CLIENTS));

describe('judgeImage: unsafe only when both models agree', () => {
  it.each([
    ['both safe', SAFE, SAFE, false],
    ['only A unsafe (violence B never scores)', VIOLENT_A, SAFE, false],
    ['only B unsafe', SAFE, NSFW, false],
    ['both unsafe', NSFW, NSFW, true],
    ['A service-flagged but under our bar, B unsafe', NEWS_A, NSFW, false],
  ])('%s', async (_name, va, vb, unsafe) => {
    const { dual } = load({ a: { x: va }, b: { x: vb } });
    const r = await dual.judgeImage('x');
    expect(r.unsafe).toBe(unsafe);
  });

  it('either model saying safe is enough when the other is down', async () => {
    const { dual } = load({ a: { x: SAFE }, b: { x: new Error('B down') } });
    await expect(dual.judgeImage('x')).resolves.toMatchObject({ unsafe: false });
    const { dual: d2 } = load({ a: { x: new Error('A down') }, b: { x: SAFE } });
    await expect(d2.judgeImage('x')).resolves.toMatchObject({ unsafe: false });
  });

  it('one model unsafe and the other unable to answer is unavailable, not a verdict', async () => {
    const { dual } = load({ a: { x: NSFW }, b: { x: new Error('B down') } });
    await expect(dual.judgeImage('x')).rejects.toThrow(dual.DualVerdictUnavailable);
    const { dual: d2 } = load({ a: { x: PROC_ERR }, b: { x: NSFW } });
    await expect(d2.judgeImage('x')).rejects.toThrow(/could not check/);
  });

  it('both models down is unavailable', async () => {
    const { dual } = load({ a: { x: new Error('down') }, b: { x: new Error('down') } });
    await expect(dual.judgeImage('x')).rejects.toThrow(/both image models failed/);
  });

  it('both processing errors: not evidence, counted as errored', async () => {
    const { dual } = load({ a: { x: PROC_ERR }, b: { x: PROC_ERR } });
    await expect(dual.judgeImage('x')).resolves.toMatchObject({ unsafe: false, errored: true });
  });
});

describe('judgeFrames', () => {
  it('sends every frame to BOTH models, one image per request, never a list call', async () => {
    const { dual, clients } = load({ a: () => NEWS_A });
    const r = await dual.judgeFrames(urls(30));
    expect(r).toMatchObject({ safe: true, checked: 30, scored: 30, flagged: 0, mode: 'per-frame' });
    expect(clients.moderateImage).toHaveBeenCalledTimes(30);
    expect(clients.moderateImageB).toHaveBeenCalledTimes(30);
    expect(clients.moderateImagesB).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i += 1) {
      expect(clients.moderateImage).toHaveBeenCalledWith(`f${i}`);
      expect(clients.moderateImageB).toHaveBeenCalledWith(`f${i}`);
    }
  });

  it('stops scoring once a frame is flagged by both', async () => {
    const { dual, clients } = load({ a: { f0: NSFW }, b: { f0: NSFW } });
    const r = await dual.judgeFrames(urls(30));
    expect(r).toMatchObject({ safe: false, flaggedIndex: 0 });
    // Only the frames already in flight (4) were scored.
    expect(clients.moderateImage.mock.calls.length).toBeLessThan(30);
  });

  it('the real clean videos pass: A flags most frames at its service bar, B none', async () => {
    const { dual } = load({ a: () => NEWS_A });
    await expect(dual.judgeFrames(urls(26))).resolves.toMatchObject({ safe: true });
  });

  it('ONE frame flagged by both rejects, and names that frame', async () => {
    const { dual } = load({ a: { f17: NSFW }, b: { f17: NSFW } });
    const r = await dual.judgeFrames(urls(30));
    expect(r).toMatchObject({ safe: false, flagged: 1, needed: 1, flaggedIndex: 17, mode: 'per-frame' });
    expect(r.reason).toMatch(/nsfw/);
  });

  it('B flags the list but A disagrees on every frame: passes', async () => {
    const { dual, clients } = load({ b: { f3: NSFW } });
    const r = await dual.judgeFrames(urls(10));
    expect(r).toMatchObject({ safe: true, flagged: 0, mode: 'per-frame' });
    expect(clients.moderateImage).toHaveBeenCalledTimes(10);
  });

  it('A and B flagging DIFFERENT frames is not agreement', async () => {
    const { dual } = load({ a: { f1: NSFW }, b: { f2: NSFW } });
    await expect(dual.judgeFrames(urls(5))).resolves.toMatchObject({ safe: true, flagged: 0 });
  });

  it('confirmation that cannot reach agreement throws (pipeline rejects as unavailable)', async () => {
    const { dual } = load({ a: { f0: new Error('A down') }, b: { f0: NSFW } });
    await expect(dual.judgeFrames(urls(3))).rejects.toThrow(dual.DualVerdictUnavailable);
  });

  it('no frames: safe, no calls', async () => {
    const { dual, clients } = load();
    await expect(dual.judgeFrames([])).resolves.toMatchObject({ safe: true, checked: 0 });
    expect(clients.moderateImage).not.toHaveBeenCalled();
    expect(clients.moderateImageB).not.toHaveBeenCalled();
  });

  it('DUAL_FRAME_MIN_FLAGGED raises the bar', async () => {
    process.env.DUAL_FRAME_MIN_FLAGGED = '2';
    try {
      const { dual } = load({ a: { f1: NSFW }, b: { f1: NSFW } });
      await expect(dual.judgeFrames(urls(5))).resolves.toMatchObject({ safe: true, flagged: 1, needed: 2 });
    } finally {
      delete process.env.DUAL_FRAME_MIN_FLAGGED;
    }
  });
});

describe('dualModelJudges.judgeThumbnail', () => {
  it('rejects only when both models flag the thumbnail', async () => {
    const { dual } = load({ a: { t: NSFW }, b: { t: NSFW } });
    await expect(dual.dualModelJudges.judgeThumbnail('t')).resolves.toMatchObject({ unsafe: true });
    const { dual: d2 } = load({ a: { t: VIOLENT_A } });
    await expect(d2.dualModelJudges.judgeThumbnail('t')).resolves.toMatchObject({ unsafe: false });
  });
});
