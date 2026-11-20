const mongoose = require('mongoose');

// Kept in its own collection rather than on videoSchema, so the existing upload route and
// every other video query are completely unaffected.
//
// Only accepted uploads get a document here: a rejected video is removed from Cloudinary
// and leaves no trace anywhere. The transcript is worth storing because it costs real ASR
// quota to produce - regenerating it later would spend that quota again on a video that
// has already been approved.
const transcriptSchema = new mongoose.Schema(
  {
    video: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Video',
      required: true,
      unique: true,
      index: true,
    },

    // English text, regardless of the language actually spoken.
    text: {
      type: String,
      default: '',
    },

    // The provider's own label for the detected language, passed through verbatim. It is
    // a name such as 'English', not an ISO code, so do not assume 'en'.
    language: {
      type: String,
      default: null,
    },

    // Length the speech provider measured, which differs slightly from the video's.
    durationSec: {
      type: Number,
      default: null,
    },

    // The sampled frames, kept so thumbnails or previews can reuse them without
    // recomputing. Index-aligned with timestampsSec.
    frameUrls: {
      type: [String],
      default: [],
    },

    timestampsSec: {
      type: [Number],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transcript', transcriptSchema);
