

const {
  requestFrames,
  requestTranscript,
  moderateImage
} = require('./moderationClients');
// Moved to its own module so community posts and comments can reuse it without a second
// copy of the chunk-budget logic. Behaviour here is unchanged.
const { moderateLongText, maxScores } = require('./textModeration');
const { numberFromEnv } = require('../config/devDefaults');
const { IMAGE_VIOLENCE_THRESHOLD, isProcessingError, isImageUnsafe } = require('./imageModeration');

const MAX_FRAMES = 30;

/**
 * How a video's frames add up to one verdict.
 *
 * This used to reject on the FIRST frame the image service called unsafe. With a
 * per-frame false-positive rate of 0.181 (measured, see below) and 30 frames sampled,
 * that rejects
 *
 *     1 - (1 - 0.181)^30  =  99.75%
 *
 * of videos that contain nothing wrong at all - which is exactly what was observed: a
 * news clip of a man being interviewed at an airport was rejected, and so was a
 * generated SMPTE colour-bar test pattern (violence 0.39). Only a featureless white
 * frame passed.
 *
 * Raising the bar alone does not fix it. At a 0.5 threshold the per-frame FPR falls to
 * 0.081, but over 30 frames that is still 1 - 0.919^30 = 92% of clean videos rejected.
 * The single-frame rule is the dominant term, so the aggregation has to change too.
 *
 * The numbers come from moderation-eval/results/metrics.json, a 673-image hand-labelled
 * set (violence axis, 20 positives):
 *
 *     threshold   recall   fpr     precision   flagged
 *     0.3 (approx. the service's own)
 *                 0.50     0.181   0.078       128
 *     0.4         0.45     0.136   0.092        98
 *     0.5         0.40     0.081   0.131        61
 *     0.6         0.20     0.052   0.105        38
 *     0.8         0.00     0.012   0.000         8
 *
 * So: a frame counts as flagged only at or above IMAGE_VIOLENCE_THRESHOLD, and the video
 * is rejected only when a FRACTION of its frames are flagged, not one of them.
 *
 * Two things this deliberately does NOT do, both because the evidence says they would be
 * theatre rather than safety:
 *
 *   - It does not treat a very high score as decisive on its own. In the calibration the
 *     0.8-0.9 and 0.9-1.0 bins have an observed positive rate of 0.0 - the highest-scoring
 *     images in the set are not the violent ones - and at a 0.8 threshold recall is 0.00.
 *     A "one certain frame" override would add false rejections and catch nothing.
 *   - It does not use nsfw_score at all. That axis has ROC AUC 0.449, below chance, and
 *     13 of its 14 positives scored exactly 0. Feeding it in would add noise, not signal.
 *
 * READ THIS BEFORE TRUSTING THE FRAME STAGE. Violence ROC AUC is 0.669 and half the true
 * positives (10 of 20) score EXACTLY 0.000, so no threshold can ever recover them. This
 * classifier cannot support a strict filter and a usable product at the same time: the
 * old rule blocked ~everything, and any rule that lets real videos through also lets most
 * genuinely violent ones through. The frame stage is therefore a coarse backstop, not a
 * guarantee. Real protection has to come from the text and transcript stages, from a
 * better image model, and from reporting.
 */

/** Fraction of CHECKED frames that must be flagged before the video is rejected. */
const FRAME_FLAG_RATIO = () => numberFromEnv('FRAME_FLAG_RATIO', 0.4);
/**
 * A floor under the ratio, so that a SHORT video cannot be rejected by a small group.
 *
 * The ratio alone is not enough at small frame counts, because `ceil(n * 0.4)` collapses:
 * at n=5 it is 2, and two independent false flags are not rare. Probability a clean video
 * is rejected, at the 0.081 per-frame FPR:
 *
 *     frames        2       3       4       5       6       8      10
 *     floor 2    0.66%   1.86%   3.52%   5.56%   0.88%   0.23%   0.61%
 *     floor 3    0.00%   0.05%   0.20%   0.47%   0.88%   0.23%   0.61%
 *
 * One in eighteen short clips at floor 2. Hence 3.
 *
 * In practice this is a backstop rather than the binding constraint: the frame sampler's
 * f_min is 8 (transcript-and-frames/app/services/frame_math.py), and the route asks for at
 * most MAX_FRAMES, so n is 8..30 and `ceil(n * 0.4)` is already 4 or more. The floor
 * exists so the guarantee does not silently depend on that config - lowering f_min, or
 * setting the service's max_frames low, must not reintroduce small-group rejections.
 * `frameAggregation.test.js` asserts the guarantee across the whole 8..30 range.
 *
 * NOTE: this applies to VIDEO FRAMES only, where many samples make a group judgement
 * possible. The thumbnail stage and community post images are single images - there is no
 * group to take, the one verdict is the whole evidence, and they are decided on it alone.
 */
const FRAME_MIN_FLAGGED = () => numberFromEnv('FRAME_MIN_FLAGGED', 3);

/**
 * The same shape as the frame rule, for the same reason, applied to transcript chunks.
 *
 * A short video is a handful of chunks, so the floor matters here as it does for frames:
 * without it, `ceil(2 * 0.4)` is 1 and a two-chunk transcript is back to one-chunk
 * rejection. The severe labels bypass all of this and reject on their own chunk.
 */
const TRANSCRIPT_FLAG_RATIO = () => numberFromEnv('TRANSCRIPT_FLAG_RATIO', 0.4);
const TRANSCRIPT_MIN_FLAGGED = () => numberFromEnv('TRANSCRIPT_MIN_FLAGGED', 2);

const REJECTION_MESSAGES = {
  text: 'inappropriate title or description',
  thumbnail: 'inappropriate thumbnail image',
  frames: 'inappropriate visual content',
  transcript: 'inappropriate spoken content',
  unavailable: 'content could not be checked, please try again'
};

/**
 * Scores every frame and rejects only when a large enough FRACTION is flagged.
 * See imageModeration.js for the per-image bar, and for what this cannot do.
 */
const moderateFrames = async (frameUrls) => {
  const threshold = IMAGE_VIOLENCE_THRESHOLD();
  const ratio = FRAME_FLAG_RATIO();
  const minFlagged = FRAME_MIN_FLAGGED();

  let worst = { nsfw_score: 0, violence_score: 0 };
  const flaggedIndexes = [];
  let errored = 0;
  let firstReason = null;

  for (let index = 0; index < frameUrls.length; index += 1) {
    const verdict = await moderateImage(frameUrls[index]);

    worst = {
      nsfw_score: Math.max(worst.nsfw_score, verdict.nsfw_score || 0),
      violence_score: Math.max(worst.violence_score, verdict.violence_score || 0)
    };

    if (isProcessingError(verdict)) {
      errored += 1;
      continue;
    }

    // The service's own `safe` flag sits at roughly a 0.3 threshold, where the measured
    // FPR is 0.181. The score is re-thresholded here instead so the operating point is
    // ours and is tunable without redeploying the model.
    if (isImageUnsafe(verdict)) {
      flaggedIndexes.push(index);
      if (!firstReason) firstReason = verdict.reason || 'violent or disturbing image detected';
    }

    // Decide as soon as the remaining frames cannot change the answer. This keeps the
    // early exit that made rejections cheap, without letting one frame decide.
    const needed = Math.max(minFlagged, Math.ceil(frameUrls.length * ratio));
    const remaining = frameUrls.length - index - 1;
    if (flaggedIndexes.length >= needed) break;
    if (flaggedIndexes.length + remaining < needed) break;
  }

  const checked = frameUrls.length;
  const needed = Math.max(minFlagged, Math.ceil(checked * ratio));
  const unsafe = flaggedIndexes.length >= needed;

  return {
    safe: !unsafe,
    checked,
    flagged: flaggedIndexes.length,
    needed,
    errored,
    threshold,
    // The first flagged frame, for the "at Ns" detail. Null when nothing was flagged.
    flaggedIndex: unsafe ? flaggedIndexes[0] : null,
    reason: unsafe ? firstReason : null,
    scores: worst
  };
};

const reject = (stage, detail) => ({
  accepted: false,
  stage,
  message: REJECTION_MESSAGES[stage] || REJECTION_MESSAGES.unavailable,
  detail
});

/**
 * `onStage` is optional and defaults to a no-op, so the two existing callers are
 * unaffected. It exists because the async upload path needs to report which gate is
 * running — a progress bar that sits at 100% for four minutes while frames are checked
 * reads as frozen, and "Checking the audio" does not.
 *
 * Percentages are rough and deliberately so: the stages have wildly different and
 * unpredictable durations, so these are ordering hints for the UI, not estimates.
 */
const moderateUpload = async (
  { title, description, videoUrl, thumbnailUrl, videoId, durationSec },
  { onStage = () => {} } = {}
) => {
  const log = { stages: {} };
  const report = (stage, pct) => {
    // A reporting failure must never fail an upload.
    try { onStage(stage, { pct }); } catch { /* ignore */ }
  };

  // --- 1. title and description: one call, before anything expensive ----------------
  report('text', 10);
  const combined = [title, description].filter(Boolean).join('. ');
  const textVerdict = await moderateLongText(combined);
  log.stages.text = textVerdict;
  if (!textVerdict.safe) return { ...reject('text'), log };

  // --- 2. thumbnail: one more call, still before the expensive work -----------------
  report('thumbnail', 20);
  if (thumbnailUrl) {
    const thumbVerdict = await moderateImage(thumbnailUrl);
    log.stages.thumbnail = thumbVerdict;
    /**
     * Still a single-image decision - one thumbnail is the whole evidence, there is no
     * group to take a fraction of - but judged at OUR bar, not the service's.
     *
     * It used to read `thumbVerdict.safe === false`, which is the service's own ~0.3
     * threshold and an 0.181 false-positive rate. That rejected a screenshot of an exam
     * timetable, and with it a 9-minute video whose every frame had passed. One stage on
     * a looser bar than the rest makes the strictest surface the one nobody tuned.
     */
    if (isImageUnsafe(thumbVerdict)) {
      return { ...reject('thumbnail', thumbVerdict.reason), log };
    }
  }

  // --- 3. the expensive half, both halves started together --------------------------
  report('extracting', 35);
  const [framesResult, transcriptResult] = await Promise.allSettled([
    requestFrames({ cloudinaryUrl: videoUrl, videoId, durationSec, maxFrames: MAX_FRAMES }),
    requestTranscript({ cloudinaryUrl: videoUrl })
  ]);

  if (framesResult.status === 'rejected') {
    log.stages.frames = { error: framesResult.reason?.message };
    return { ...reject('unavailable', 'frame sampling failed'), log };
  }
  if (transcriptResult.status === 'rejected') {
    log.stages.transcript = { error: transcriptResult.reason?.message };
    return { ...reject('unavailable', 'transcription failed'), log };
  }

  const frames = framesResult.value;
  const transcript = transcriptResult.value;

  // An independent measurement of the same asset. A seconds/milliseconds mix-up in the
  // duration we sent would show up here as a roughly 1000x discrepancy.
  const reportedDuration = transcript.audio_duration_sec;
  if (typeof reportedDuration === 'number' && reportedDuration > 0 && durationSec > 0) {
    const ratio = durationSec / reportedDuration;
    if (ratio < 0.5 || ratio > 2) {
      console.warn(
        `[uploadV2] duration mismatch: sent ${durationSec}s, transcript reports ` +
          `${reportedDuration}s (ratio ${ratio.toFixed(3)}). Frame sampling may be wrong.`
      );
    }
  }

  // --- 4. frames and transcript text, concurrently ----------------------------------
  report('frames', 60);
  const [frameVerdictResult, transcriptVerdictResult] = await Promise.allSettled([
    moderateFrames(frames.frame_urls || []),
    moderateLongText(transcript.english_text || '')
  ]);

  if (frameVerdictResult.status === 'rejected') {
    log.stages.frameModeration = { error: frameVerdictResult.reason?.message };
    return { ...reject('unavailable', 'frame moderation failed'), log };
  }
  if (transcriptVerdictResult.status === 'rejected') {
    log.stages.transcriptModeration = { error: transcriptVerdictResult.reason?.message };
    return { ...reject('unavailable', 'transcript moderation failed'), log };
  }

  const frameVerdict = frameVerdictResult.value;
  const transcriptVerdict = transcriptVerdictResult.value;
  log.stages.frameModeration = frameVerdict;
  log.stages.transcriptModeration = transcriptVerdict;

  if (!frameVerdict.safe) {
    // The flagged index maps back to frames.frames[i].timestamp_sec, which is the only
    // way to say WHEN in the video the problem was - the aggregate verdict cannot.
    //
    // The count goes in the detail too: the verdict is now "N of M frames", so naming a
    // single timestamp without it would misreport an aggregate decision as a single
    // frame's, which is what the old rule actually did.
    const at = frames.frames?.[frameVerdict.flaggedIndex]?.timestamp_sec;
    const detail =
      `${frameVerdict.flagged} of ${frameVerdict.checked} frames flagged`
      + `, first at ${at}s: ${frameVerdict.reason}`;
    return { ...reject('frames', detail), log };
  }
  /**
   * Spoken content is judged across the whole transcript, not one chunk of it.
   *
   * This used to be `if (!transcriptVerdict.safe)`, which rejects when ANY chunk trips -
   * the same shape as the old one-frame rule, and it fails the same way. A 9-minute video
   * yields ~10 chunks of ASR output scored without context, so any per-chunk error rate is
   * multiplied by ten. A study-tips video was rejected on a single chunk reading 0.69 for
   * toxicity.
   *
   * A severe chunk - a threat, an identity attack - still rejects on its own. That is the
   * line between "one noisy chunk out of ten" and "one chunk that said something serious",
   * and it is why the severe labels keep their own lower bar in textModeration.js.
   */
  const transcriptChunks = transcriptVerdict.chunks || 0;
  const transcriptNeeded = Math.max(
    TRANSCRIPT_MIN_FLAGGED(),
    Math.ceil(transcriptChunks * TRANSCRIPT_FLAG_RATIO())
  );
  const transcriptUnsafe =
    (transcriptVerdict.severeChunks || 0) > 0
    || (transcriptVerdict.flaggedChunks || 0) >= transcriptNeeded;

  log.stages.transcriptModeration = { ...transcriptVerdict, needed: transcriptNeeded };

  if (transcriptUnsafe) {
    return { ...reject('transcript'), log };
  }

  return {
    accepted: true,
    log,
    transcript: {
      text: transcript.english_text || '',
      language: transcript.detected_language || null,
      durationSec: reportedDuration ?? null
    },
    frames: {
      urls: frames.frame_urls || [],
      timestamps: frames.timestamps_sec || [],
      requested: frames.requested_frame_count,
      returned: frames.frame_count
    }
  };
};

module.exports = { moderateUpload, moderateFrames, MAX_FRAMES, REJECTION_MESSAGES };
