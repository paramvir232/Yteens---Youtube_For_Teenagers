const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
  {
    url:{
      type:String,
      required: true,
    },
    
    title: {
      type: String,
      required: true,
    },

    description: {
      type: String,
    },

    tags: {
      type: [String], // ['math', 'science']
      default: [],
    },

    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },

    views: {
      count: {
        type: Number,
        default: 0,
      },
      viewers: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Channel',
        }
      ]
    },

    likes: {
      count: {
        type: Number,
        default: 0,
      },
      by: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Channel',
        }
      ]
    },

    comments: [
      {
        channel: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Channel',
        },
        comment: {
          type: String,
        },
        at: {
          type: Date,
          default: Date.now,
        }
      }
    ],

    uploadedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Video', videoSchema);
