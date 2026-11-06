const { chunkForQuery } = require('../util/textChunker');
const { moderateText } = require('./moderationClients');
const { numberFromEnv } = require('../config/devDefaults');

/**
 * Our own bar for text, rather than the service's `safe` flag.
 *
 * UNLIKE the image thresholds, these are NOT backed by a labelled evaluation.
 * moderation-eval covers the image axes only (results/metrics.json has violence and nsfw
 * and nothing else), so there is no sweep to read a number off. These are a stated policy
 * to be calibrated once text labels exist - do not mistake them for measured values.
 *
 * The policy: 0.7 for the general labels, matching the bar chosen for images, and a lower
 * 0.5 for the severe ones. The split is the point. A transcript is ASR output from minutes
 * of speech, chopped into chunks and scored without context, so one chunk reading 0.69 for
 * "toxicity" is weak evidence - a 9-minute study-tips video was rejected on exactly that.
 * A chunk scoring high for a THREAT or an identity attack is not weak evidence, and those
 * labels stay sensitive and still reject on their own.
 */
const SEVERE_LABELS = ['severe_toxicity', 'threat', 'identity_attack'];
const GENERAL_LABELS = ['toxicity', 'insult', 'obscene'];

const TEXT_TOXICITY_THRESHOLD = () => numberFromEnv('TEXT_TOXICITY_THRESHOLD', 0.7);
const TEXT_SEVERE_THRESHOLD = () => numberFromEnv('TEXT_SEVERE_THRESHOLD', 0.5);

/** What one chunk's scores trip, by our bar. */
const chunkFlags = (verdict) => {
  const scores = verdict?.scores || {};
  const severe = SEVERE_LABELS.some((l) => (scores[l] || 0) >= TEXT_SEVERE_THRESHOLD());
  const general = GENERAL_LABELS.some((l) => (scores[l] || 0) >= TEXT_TOXICITY_THRESHOLD());
  return { severe, general, unsafe: severe || general };
};

/**
 * Moderating a body of text of any length.
 *
 * Moved out of moderationPipeline.js, where it was module-private, because community
 * posts and comments need exactly this and copying it would leave two implementations
 * of the 1500-byte percent-encoded chunk budget to drift apart. moderationPipeline now
 * imports from here; its behaviour is unchanged.
 */

/**
 * Highest score seen for each label across every chunk.
 *
 * Recorded for the audit log, never used to override a verdict — the services own their
 * own thresholds, and second-guessing them here would mean this file needs editing
 * whenever they retune.
 */
const maxScores = (verdicts) => {
  const merged = {};
  for (const verdict of verdicts) {
    for (const [key, value] of Object.entries(verdict.scores || {})) {
      if (typeof value === 'number') {
        merged[key] = Math.max(merged[key] ?? 0, value);
      }
    }
  }
  return merged;
};

/**
 * Score every chunk.
 *
 * Unlike the frame loop, which short-circuits at the first unsafe frame, text is only a
 * handful of calls — so the full picture is affordable and worth having in the log.
 *
 * Empty input is safe-and-skipped rather than an error: a post with no body is a
 * validation problem, not a moderation one.
 */
const moderateLongText = async (text) => {
  const chunks = chunkForQuery(text);
  if (chunks.length === 0) {
    return { safe: true, skipped: true, chunks: 0, scores: {} };
  }

  const verdicts = [];
  for (const chunk of chunks) {
    verdicts.push(await moderateText(chunk));
  }

  const flags = verdicts.map(chunkFlags);

  /**
   * `safe` stays "no chunk tripped the bar", which is right for SHORT text - a community
   * post or comment is usually one chunk, so that chunk is the whole evidence, exactly as
   * one thumbnail is.
   *
   * A long transcript needs a different reading, and the caller does that with
   * `flaggedChunks` / `severeChunks` below rather than this flag. See the transcript stage
   * in moderationPipeline.js.
   */
  return {
    safe: !flags.some((f) => f.unsafe),
    skipped: false,
    chunks: chunks.length,
    flaggedChunks: flags.filter((f) => f.unsafe).length,
    severeChunks: flags.filter((f) => f.severe).length,
    scores: maxScores(verdicts),
  };
};

module.exports = {
  moderateLongText,
  maxScores,
  chunkFlags,
  TEXT_TOXICITY_THRESHOLD,
  TEXT_SEVERE_THRESHOLD
};
