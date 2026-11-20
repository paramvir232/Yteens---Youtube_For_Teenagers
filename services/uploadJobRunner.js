const Video = require('../models/videoModel');
const Channel = require('../models/channelModel');
const Transcript = require('../models/transcriptModel');
const UploadAttempt = require('../models/uploadAttemptModel');
const UploadJob = require('../models/uploadJobModel');
const { moderateUpload } = require('./moderationPipeline');

/**
 * Running an upload through moderation and persisting the outcome.
 *
 * Shared by both the blocking route and the async job path so the two cannot drift —
 * the thing that must never differ between them is what ends up in the database.
 */

/**
 * Record the attempt. Best-effort: never let auditing fail an upload.
 *
 * Mirrors how the existing Transcript.create is wrapped. A video that passed moderation
 * and was saved must not turn into a 500 because a log row could not be written.
 */
async function recordAttempt(fields) {
  try {
    return await UploadAttempt.create(fields);
  } catch (err) {
    console.error('[uploadV2] could not record the upload attempt:', err.message);
    return null;
  }
}

/**
 * Persist an accepted video: the Video, the channel link, and the Transcript.
 *
 * The transcript is written inside its own try/catch — that is existing behaviour and
 * deliberately preserved. A transcript is useful but not load-bearing; losing it must
 * not lose the video that is already saved and already in the channel.
 */
async function persistAccepted({ channel, title, description, tags, videoUrl, thumbnailUrl, verdict }) {
  const tagArray = tags ? tags.split(',').map((tag) => tag.trim().toLowerCase()) : [];

  const newVideo = await Video.create({
    title,
    description,
    tags: tagArray,
    url: videoUrl,
    thumbnailUrl,
    channel: channel._id,
  });

  channel.videos.push(newVideo._id);
  await channel.save();

  try {
    await Transcript.create({
      video: newVideo._id,
      text: verdict.transcript.text,
      language: verdict.transcript.language,
      durationSec: verdict.transcript.durationSec,
      frameUrls: verdict.frames.urls,
      timestampsSec: verdict.frames.timestamps,
    });
  } catch (err) {
    console.error(
      `[uploadV2] video ${newVideo._id} saved, but its transcript could not be stored:`,
      err.message
    );
  }

  return newVideo;
}

/**
 * Moderate one upload and record what happened. Used by both paths.
 *
 * Returns { accepted, video, verdict, attempt }. Never throws for a moderation
 * rejection — that is a result, not an error.
 */
async function runModeration(ctx) {
  const {
    channel, title, description, tags,
    videoUrl, thumbnailUrl, videoPublicId, thumbnailPublicId,
    durationSec, userId = null, job = null, onStage,
  } = ctx;

  const verdict = await moderateUpload(
    { title, description, videoUrl, thumbnailUrl, videoId: videoPublicId, durationSec },
    { onStage }
  );

  const base = {
    channel: channel._id,
    user: userId,
    title: title || '',
    description: description || '',
    tags: tags ? tags.split(',').map((t) => t.trim()) : [],
    videoPublicId: videoPublicId || '',
    thumbnailPublicId: thumbnailPublicId || '',
    durationSec: durationSec ?? null,
    scores: verdict.log?.stages ?? null,
    job: job?._id ?? null,
  };

  if (!verdict.accepted) {
    console.warn(
      `[uploadV2] rejected at '${verdict.stage}'`,
      JSON.stringify({ channelId: String(channel._id), detail: verdict.detail })
    );
    const attempt = await recordAttempt({
      ...base,
      outcome: 'rejected',
      stage: verdict.stage,
      message: verdict.message || '',
      detail: verdict.detail || '',
    });
    return { accepted: false, verdict, attempt, video: null };
  }

  const video = await persistAccepted({
    channel, title, description, tags, videoUrl, thumbnailUrl, verdict,
  });

  const attempt = await recordAttempt({ ...base, outcome: 'accepted', video: video._id });
  return { accepted: true, verdict, attempt, video };
}

/**
 * Run a job in the background and keep its row up to date.
 *
 * Deliberately NOT awaited by the caller — the whole point is that the HTTP response
 * has already gone out. Errors are therefore caught here and written to the job, not
 * thrown: an unhandled rejection in a detached promise would take the process down.
 */
function startJob(jobId, ctx, cleanup) {
  setImmediate(async () => {
    const touch = (fields) =>
      UploadJob.updateOne({ _id: jobId }, { $set: { ...fields, heartbeatAt: new Date() } }).catch(
        () => {}
      );

    await touch({ status: 'running', pct: 5, message: 'Checking your video' });

    try {
      const result = await runModeration({
        ...ctx,
        job: { _id: jobId },
        onStage: (stage, { pct }) => touch({ stage, pct, message: stageMessage(stage) }),
      });

      if (result.accepted) {
        await touch({
          status: 'accepted',
          pct: 100,
          stage: null,
          message: 'Published',
          video: result.video._id,
          attempt: result.attempt?._id ?? null,
        });
      } else {
        await touch({
          status: 'rejected',
          pct: 100,
          stage: result.verdict.stage,
          message: result.verdict.message || 'Upload rejected',
          attempt: result.attempt?._id ?? null,
        });
        await cleanup();
      }
    } catch (err) {
      console.error('[uploadV2] job failed:', err.message);
      await touch({ status: 'failed', pct: 100, message: 'Something went wrong. Please try again.' });
      await cleanup();
    }
  });
}

const STAGE_MESSAGES = {
  text: 'Checking the title and description',
  thumbnail: 'Checking the thumbnail',
  extracting: 'Reading the audio and sampling frames',
  frames: 'Checking what is on screen',
};

const stageMessage = (stage) => STAGE_MESSAGES[stage] || 'Checking your video';

/**
 * Mark jobs abandoned by a dead process as failed.
 *
 * In-process jobs do not survive a restart, so without this a crash during moderation
 * leaves a row stuck in `running` and a client polling it forever.
 */
async function sweepStaleJobs({ olderThanMs = 15 * 60 * 1000 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await UploadJob.updateMany(
    { status: { $in: ['queued', 'running'] }, heartbeatAt: { $lt: cutoff } },
    {
      $set: {
        status: 'failed',
        message: 'This upload was interrupted. Please try again.',
        pct: 100,
      },
    }
  );
  if (result.modifiedCount) {
    console.warn(`[uploadV2] swept ${result.modifiedCount} stale upload job(s)`);
  }
  return result.modifiedCount;
}

module.exports = { runModeration, startJob, sweepStaleJobs, recordAttempt, stageMessage };
