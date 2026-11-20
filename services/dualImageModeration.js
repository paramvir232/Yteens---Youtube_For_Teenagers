const { moderateImage, moderateImageB } = require('./moderationClients');
const { isImageUnsafe, isProcessingError } = require('./imageModeration');
const { numberFromEnv } = require('../config/devDefaults');

/**
 * Two image models, one decision. Used by /api/v3/upload (thumbnail + frames) and by
 * community post images.
 *
 * THE RULE (product decision): an image is unsafe only when BOTH models say it is unsafe.
 * If either model says safe, it is safe. Each model is judged on the app's own bar
 * (isImageUnsafe: violence >= 0.7 or nsfw >= 0.5), not the service's ~0.3 `safe` flag.
 *
 * WHAT THE DATA SAID (moderation-eval, scripts/score_image_models.py and
 * two_model_analysis.py; 721 images scored one per call by each model, plus 34 real
 * frames and list-call probes):
 *
 *   - Model B returns violence_score = 0 for every image, and its nsfw_score is model A's
 *     nsfw_score (identical on 580/721; B rounds A's small values down to 0). It flagged
 *     6 images, all explicit nudity, all also flagged by A.
 *   - So under "both must agree", a frame is flagged only for confident NSFW. On the 653
 *     safe images it flagged none (FPR 0%), and both real clean videos (news interview,
 *     test pattern) had 0 flagged frames, where A alone flagged 25/26 and 6/8 at its
 *     service bar. Violence is no longer caught by the image stage at all - the text and
 *     transcript stages still are.
 *   - Because a both-flagged frame has never been a false positive, ONE such frame rejects
 *     the video. The old group rule (>= max(3, 40%)) existed to absorb A's false flags;
 *     here it would only let a video with a few explicit frames through.
 *     (DUAL_FRAME_MIN_FLAGGED, default 1.)
 *   - A list call returns ONE verdict for the whole list, flagged when any frame is, with
 *     that frame's score (probed with the bad frame first, middle and last). Model B on
 *     30 urls: ~28 s, versus ~3 s per single url.
 *
 * DESIGN: every frame is sent to BOTH models, one image per request (both models in
 * parallel for a frame, up to CONFIRM_CONCURRENCY frames in flight), and that frame's
 * verdict comes from the two models' scores. List calls are not used for the decision:
 * a list gets one verdict for all its images, which cannot say whether the SAME frame
 * was flagged by both. Checking stops early once enough frames are flagged by both.
 *
 * FAILURES: a model that throws or answers "image processing error" gives no verdict.
 * The other model's SAFE is then enough (rule: either safe => safe). Its UNSAFE is not,
 * since agreement cannot be checked - that throws, and the pipeline rejects as
 * 'unavailable' (try again) rather than publishing or blaming the uploader.
 */

const DUAL_FRAME_MIN_FLAGGED = () => numberFromEnv('DUAL_FRAME_MIN_FLAGGED', 1);
const CONFIRM_CONCURRENCY = 4;

class DualVerdictUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'DualVerdictUnavailable';
  }
}

/** 'safe' | 'unsafe' | 'none' (no usable verdict) for one settled model call. */
const readVerdict = (settled) => {
  if (settled.status !== 'fulfilled') return 'none';
  const v = settled.value;
  if (!v || isProcessingError(v)) return 'none';
  return isImageUnsafe(v) ? 'unsafe' : 'safe';
};

const worstOf = (...verdicts) => ({
  nsfw_score: Math.max(0, ...verdicts.map((v) => v?.nsfw_score || 0)),
  violence_score: Math.max(0, ...verdicts.map((v) => v?.violence_score || 0)),
});

/**
 * Judge one image with both models in parallel.
 * Resolves { unsafe, errored, reason, verdict: {a, b}, scores }.
 * Throws DualVerdictUnavailable when one model says unsafe and the other gave nothing.
 */
const judgeImage = async (url) => {
  const [a, b] = await Promise.allSettled([moderateImage(url), moderateImageB(url)]);
  const va = readVerdict(a);
  const vb = readVerdict(b);
  const verdict = {
    a: a.status === 'fulfilled' ? a.value : { error: a.reason?.message },
    b: b.status === 'fulfilled' ? b.value : { error: b.reason?.message },
  };
  const scores = worstOf(a.value, b.value);

  if (va === 'safe' || vb === 'safe') {
    return { unsafe: false, errored: false, reason: null, verdict, scores };
  }
  if (va === 'unsafe' && vb === 'unsafe') {
    const reason = verdict.b.reason || verdict.a.reason || 'unsafe image detected';
    return { unsafe: true, errored: false, reason, verdict, scores };
  }
  if (va === 'none' && vb === 'none') {
    // Neither model could look at it. Same as the single-model path: not evidence either
    // way, counted so a broken frame pipeline is visible in the log. If BOTH calls threw,
    // the services are down - that is unavailability, not an unreadable image.
    if (a.status === 'rejected' && b.status === 'rejected') {
      throw new DualVerdictUnavailable(`both image models failed: ${a.reason?.message}`);
    }
    return { unsafe: false, errored: true, reason: null, verdict, scores };
  }
  throw new DualVerdictUnavailable('one image model flagged the image and the other could not check it');
};

/** Run fn over items with at most `limit` in flight; results in input order. */
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/**
 * Judge a video's sampled frames: each frame by both models, one image per request.
 * Resolves the moderateFrames() shape the pipeline reads:
 * { safe, checked, flagged, needed, errored, flaggedIndex, reason, scores, mode }.
 */
const judgeFrames = async (frameUrls) => {
  const urls = frameUrls || [];
  const needed = Math.max(1, DUAL_FRAME_MIN_FLAGGED());
  const results = new Array(urls.length).fill(null);
  let flaggedCount = 0;

  await mapLimit(urls, CONFIRM_CONCURRENCY, async (url, i) => {
    if (flaggedCount >= needed) return; // decided: skip the rest
    const r = await judgeImage(url);
    results[i] = r;
    if (r.unsafe) flaggedCount += 1;
  });

  const done = results.filter(Boolean);
  const flaggedIndexes = results.map((r, i) => (r?.unsafe ? i : -1)).filter((i) => i >= 0);
  const unsafe = flaggedIndexes.length >= needed;
  return {
    safe: !unsafe,
    checked: urls.length,
    scored: done.length,
    flagged: flaggedIndexes.length,
    needed,
    errored: done.filter((r) => r.errored).length,
    flaggedIndex: unsafe ? flaggedIndexes[0] : null,
    reason: unsafe ? results[flaggedIndexes[0]].reason : null,
    scores: worstOf(...done.map((r) => r.scores)),
    mode: 'per-frame',
  };
};

/** Pipeline judges for moderateUpload (see moderationPipeline.js singleModelJudges). */
const dualModelJudges = {
  judgeThumbnail: async (url) => {
    const r = await judgeImage(url);
    return { unsafe: r.unsafe, reason: r.reason, verdict: r.verdict };
  },
  judgeFrames,
};

module.exports = {
  judgeImage,
  judgeFrames,
  dualModelJudges,
  DualVerdictUnavailable,
  DUAL_FRAME_MIN_FLAGGED,
};
