const { numberFromEnv } = require('../config/devDefaults');

/**
 * One bar for every image decision in the product.
 *
 * The image service answers with `safe` plus `nsfw_score` and `violence_score`. Its own
 * `safe` flag sits at roughly a 0.3 threshold, where the measured per-frame false-positive
 * rate is 0.181 - trigger-happy enough that it rejected a generated SMPTE colour-bar
 * pattern (0.39) and a screenshot of an exam timetable. Taking the score and applying our
 * own threshold puts the operating point here, where it can be tuned without redeploying
 * the model, and keeps every surface on the same bar.
 *
 * Before this existed the surfaces disagreed: video frames had been re-thresholded while
 * the thumbnail and community post images still trusted `safe`, so an image that would not
 * have flagged a single frame could still reject the whole upload as a thumbnail. That is
 * exactly how a 9-minute video that passed every frame check was rejected on its
 * thumbnail.
 *
 * THE DEFAULT IS DELIBERATE AND IT IS PERMISSIVE. From moderation-eval's 673-image labelled
 * set (results/metrics.json, violence axis, 20 positives):
 *
 *     threshold   recall   fpr     precision
 *     0.3         0.50     0.181   0.078      <- the service's own
 *     0.5         0.40     0.081   0.131
 *     0.7         0.05     0.029   0.050      <- here
 *     0.8         0.00     0.012   0.000
 *
 * At 0.7 this catches roughly one in twenty genuinely violent images. It is close to
 * turning the visual check off, and that is a reasonable trade only because the classifier
 * is weak enough to be worse than useless at a strict setting: violence ROC AUC is 0.669,
 * 10 of the 20 positives score EXACTLY 0.000, and the 0.8-1.0 calibration bins have an
 * observed positive rate of 0.0 - the highest-scoring images in the set are not the violent
 * ones. A stricter bar buys false rejections, not safety.
 *
 * Treat the visual stage as a coarse backstop. Protection for a 10-20 audience has to come
 * from the text and transcript stages, a better image model, and reporting.
 *
 * nsfw_score gets its own threshold rather than being dropped.
 *
 * It is a weak axis - ROC AUC 0.449, below chance, 13 of its 14 labelled positives scoring
 * exactly 0.000 - and the first cut of this module ignored it for that reason. That was
 * wrong, because "weak" and "harmless to keep" are different questions. In the labelled
 * set the score is 0 for almost everything: at 0.05 only 2 of 719 images are flagged and
 * at 0.1 none are. So a threshold at 0.5 costs nothing in false rejections - it rejects
 * NOTHING in the whole set - while still catching an image the model is outright confident
 * about. Ignoring the axis would have unblocked NSFW imagery across every surface to buy
 * an improvement of zero.
 *
 * The asymmetry with violence is deliberate. Violence scores high on safe images (17 safe
 * images score above the worst violent one), so a low bar there causes real false
 * rejections. NSFW does not behave that way, so the bar can sit where it catches the
 * confident cases for free.
 *
 * This does NOT make NSFW detection adequate - a model that scores 13 of 14 positives at
 * zero is not protecting anyone. It needs replacing. This keeps whatever signal exists in
 * the meantime instead of throwing it away.
 */
const IMAGE_VIOLENCE_THRESHOLD = () => numberFromEnv('IMAGE_VIOLENCE_THRESHOLD', 0.7);
const IMAGE_NSFW_THRESHOLD = () => numberFromEnv('IMAGE_NSFW_THRESHOLD', 0.5);

/**
 * A verdict that is really a failure to look at the image.
 *
 * The service answers an unreachable or undecodable URL with
 * `{ safe: false, nsfw_score: 0, violence_score: 0, reason: 'image processing error' }` -
 * a transport failure dressed as a verdict. Counting it as evidence would reject content
 * over a network blip; silently counting it as safe would hide a broken frame pipeline.
 * Callers distinguish it and report it.
 */
const isProcessingError = (verdict) =>
  verdict?.safe === false
  && !(verdict.violence_score > 0)
  && !(verdict.nsfw_score > 0)
  && /error/i.test(verdict.reason || '');

/**
 * Is this one image unsafe, by our bar rather than the service's?
 *
 * A processing error is NOT unsafe - see above. Callers that need to know the difference
 * should check `isProcessingError` themselves.
 */
const isImageUnsafe = (verdict) => {
  if (!verdict || isProcessingError(verdict)) return false;
  return (verdict.violence_score || 0) >= IMAGE_VIOLENCE_THRESHOLD()
    || (verdict.nsfw_score || 0) >= IMAGE_NSFW_THRESHOLD();
};

module.exports = {
  IMAGE_VIOLENCE_THRESHOLD,
  IMAGE_NSFW_THRESHOLD,
  isProcessingError,
  isImageUnsafe
};
