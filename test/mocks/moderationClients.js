/**
 * Stand-in for services/moderationClients.js.
 *
 * Every test MUST mock this. The real module calls Hugging Face Spaces and Groq, which
 * cost quota, are rate-limited, and are slow enough to make a test suite unusable. The
 * global axios block in test/helpers/noNetwork.js is the backstop if anyone forgets.
 *
 * Verdicts default to safe, so a test only has to state the thing it is actually
 * testing: `__setVerdicts({ text: { safe: false } })` and nothing else.
 */
const defaults = () => ({
  text: { safe: true, scores: {} },
  image: { safe: true, nsfw_score: 0, violence_score: 0, reason: null },
  frames: {
    frame_urls: ['https://res.cloudinary.com/demo/image/upload/f1.jpg'],
    timestamps_sec: [1],
    frames: [{ index: 0, timestamp_sec: 1, url: 'https://res.cloudinary.com/demo/image/upload/f1.jpg' }],
    requested_frame_count: 1,
    frame_count: 1,
  },
  transcript: {
    english_text: 'a perfectly ordinary transcript',
    detected_language: 'English',
    audio_duration_sec: 42,
  },
});

let verdicts = defaults();

/**
 * Fill in the scores a bare `{ safe: false }` implies.
 *
 * The real services never answer `safe: false` with no scores, or with zeros - zeros plus
 * `safe: false` is specifically how the image service reports a FETCH FAILURE, which is
 * not a verdict at all. Tests have always written the shorthand `{ safe: false }` to mean
 * "the service rejected this", and that was fine while the code trusted the flag.
 *
 * Now that every surface thresholds the scores itself (services/imageModeration.js,
 * services/textModeration.js), the shorthand has to carry scores or it no longer means
 * what the test says it means. Filling them in here keeps every call site reading as
 * intent - `{ safe: false }` is still "rejected" - instead of sprinkling magic numbers
 * through thirty tests.
 *
 * A test that wants a SPECIFIC score still passes one, and it is left untouched.
 */
const UNSAFE_TEXT_SCORES = {
  toxicity: 0.95, severe_toxicity: 0.4, obscene: 0.8, threat: 0.05, insult: 0.9, identity_attack: 0.05
};

const withImpliedScores = (next) => {
  const filled = { ...next };

  if (filled.text && !(filled.text instanceof Error) && filled.text.safe === false) {
    const given = filled.text.scores;
    if (!given || Object.keys(given).length === 0) {
      filled.text = { ...filled.text, scores: { ...UNSAFE_TEXT_SCORES } };
    }
  }

  if (filled.image && !(filled.image instanceof Error) && filled.image.safe === false) {
    const hasScore = (filled.image.violence_score || 0) > 0 || (filled.image.nsfw_score || 0) > 0;
    if (!hasScore && !/error/i.test(filled.image.reason || '')) {
      filled.image = {
        ...filled.image,
        violence_score: 0.95,
        nsfw_score: filled.image.nsfw_score || 0.02,
        reason: filled.image.reason || 'violent or disturbing image detected'
      };
    }
  }

  return filled;
};

/** Per-URL image overrides, so one frame can be unsafe while the thumbnail is fine. */
let imageByUrl = {};

const requestFrames = jest.fn(async () => {
  if (verdicts.frames instanceof Error) throw verdicts.frames;
  return verdicts.frames;
});

const requestTranscript = jest.fn(async () => {
  if (verdicts.transcript instanceof Error) throw verdicts.transcript;
  return verdicts.transcript;
});

const moderateText = jest.fn(async () => {
  if (verdicts.text instanceof Error) throw verdicts.text;
  return verdicts.text;
});

const moderateImage = jest.fn(async (url) => {
  const specific = imageByUrl[url];
  if (specific instanceof Error) throw specific;
  if (specific) return specific;
  if (verdicts.image instanceof Error) throw verdicts.image;
  return verdicts.image;
});

// ── Model B, and list calls for both ──────────────────────────────────────────────────
// Model B defaults to safe and has its own per-URL overrides. A list call returns ONE
// verdict, like the real services: the most unsafe image's verdict (highest score).
let imageBByUrl = {};
let imageBDefault = null; // null = safe; an Error = service down

const singleA = (url) => {
  const specific = imageByUrl[url];
  if (specific instanceof Error) throw specific;
  if (specific) return specific;
  if (verdicts.image instanceof Error) throw verdicts.image;
  return verdicts.image;
};
const SAFE = { safe: true, nsfw_score: 0, violence_score: 0, reason: null };
const singleB = (url) => {
  const specific = imageBByUrl[url];
  if (specific instanceof Error) throw specific;
  if (specific) return specific;
  if (imageBDefault instanceof Error) throw imageBDefault;
  return imageBDefault || SAFE;
};
const combine = (list) =>
  list.reduce((worst, v) => {
    const s = Math.max(v.violence_score || 0, v.nsfw_score || 0);
    const w = Math.max(worst.violence_score || 0, worst.nsfw_score || 0);
    return s > w || (v.safe === false && worst.safe !== false) ? v : worst;
  }, SAFE);

const moderateImagesA = jest.fn(async (urls) => combine(urls.map(singleA)));
const moderateImagesB = jest.fn(async (urls) => combine(urls.map(singleB)));
const moderateImageB = jest.fn(async (url) => singleB(url));

module.exports = {
  requestFrames,
  requestTranscript,
  moderateText,
  moderateImage,
  moderateImagesA,
  moderateImagesB,
  moderateImageB,
  TIMEOUTS: { frames: 30000, translate: 180000, text: 20000, image: 30000 },

  __setVerdicts(next = {}) {
    verdicts = { ...defaults(), ...withImpliedScores(next) };
  },
  __setImageVerdict(url, verdict) {
    imageByUrl[url] = withImpliedScores({ image: verdict }).image;
  },
  /** Model B for one url, or (url omitted) for every url. */
  __setImageBVerdict(url, verdict) {
    if (url === null || url === undefined) {
      imageBDefault = verdict instanceof Error ? verdict : withImpliedScores({ image: verdict }).image;
    } else {
      imageBByUrl[url] = verdict instanceof Error ? verdict : withImpliedScores({ image: verdict }).image;
    }
  },
  __resetModeration() {
    verdicts = defaults();
    imageByUrl = {};
    imageBByUrl = {};
    imageBDefault = null;
    requestFrames.mockClear();
    requestTranscript.mockClear();
    moderateText.mockClear();
    moderateImage.mockClear();
    moderateImagesA.mockClear();
    moderateImagesB.mockClear();
    moderateImageB.mockClear();
  },
};
