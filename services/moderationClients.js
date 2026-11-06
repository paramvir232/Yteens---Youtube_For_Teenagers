
const axios = require('axios');
require('dotenv').config();

const { devDefault } = require('../config/devDefaults');

// Read lazily, not at module load: the dev default announces itself with a log line, and
// doing that at require() time would fire before the process has decided what it is.
// The two moderation URLs get NO default - they are remote Spaces or the local stub, and
// a wrong guess would be worse than a clear "is not configured".
const transcriptBase = () =>
  devDefault('TRANSCRIPT_SERVICE_URL', 'http://localhost:8000');
const TRANSCRIPT_SERVICE_API_KEY = () => process.env.TRANSCRIPT_SERVICE_API_KEY;
const TEXT_MODERATION_URL = () => process.env.TEXT_MODERATION_URL;
const IMAGE_MODERATION_URL = () => process.env.IMAGE_MODERATION_URL;

// Generous enough to survive a free-tier cold start on any of the three services.
const TIMEOUTS = {
  frames: 30000,
  translate: 180000,
  text: 20000,
  image: 30000
};

const trimSlash = (url) => (url || '').replace(/\/+$/, '');

// The text service declares its response as a string while returning an object. If it
// ever returns a JSON string containing JSON, parse the extra layer rather than treating
// a valid verdict as unreadable.
const asObject = (data, label) => {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      throw new Error(`${label} returned an unparseable body`);
    }
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} returned an unexpected shape`);
  }
  return value;
};

const requireEnv = (value, name) => {
  if (!value) throw new Error(`${name} is not configured`);
  return trimSlash(value);
};

// --------------------------------------------------------------- transcript service

const requestFrames = async ({ cloudinaryUrl, videoId, durationSec, maxFrames }) => {
  const base = requireEnv(transcriptBase(), 'TRANSCRIPT_SERVICE_URL');
  const { data } = await axios.post(
    `${base}/v1/frames`,
    {
      cloudinary_url: cloudinaryUrl,
      video_id: videoId,
      duration_sec: durationSec,
      max_frames: maxFrames
    },
    {
      headers: { 'x-api-key': TRANSCRIPT_SERVICE_API_KEY() },
      timeout: TIMEOUTS.frames
    }
  );
  return asObject(data, 'frames service');
};

const requestTranscript = async ({ cloudinaryUrl }) => {
  const base = requireEnv(transcriptBase(), 'TRANSCRIPT_SERVICE_URL');
  const { data } = await axios.post(
    `${base}/v1/translate`,
    { cloudinary_url: cloudinaryUrl },
    {
      headers: { 'x-api-key': TRANSCRIPT_SERVICE_API_KEY() },
      timeout: TIMEOUTS.translate
    }
  );
  return asObject(data, 'transcript service');
};

// --------------------------------------------------------------- moderation services

// Returns { safe, scores: { toxicity, severe_toxicity, obscene, threat, insult,
// identity_attack } }.
const moderateText = async (text) => {
  const base = requireEnv(TEXT_MODERATION_URL(), 'TEXT_MODERATION_URL');
  const { data } = await axios.get(`${base}/moderate`, {
    params: { text },
    timeout: TIMEOUTS.text
  });
  return asObject(data, 'text moderation');
};

// Returns { safe, nsfw_score, violence_score, reason } for the batch as a whole.
//
// One URL per call

const moderateImage = async (url) => {
  const base = requireEnv(IMAGE_MODERATION_URL(), 'IMAGE_MODERATION_URL');
  const { data } = await axios.post(
    `${base}/moderate-images`,
    { urls: [url] },
    { timeout: TIMEOUTS.image }
  );
  return asObject(data, 'image moderation');
};

module.exports = {
  requestFrames,
  requestTranscript,
  moderateText,
  moderateImage,
  TIMEOUTS
};
