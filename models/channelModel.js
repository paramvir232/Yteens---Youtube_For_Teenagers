const mongoose = require('mongoose');

const ChannelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Channel name is required'],
      trim: true,
      minlength: 2,
      maxlength: 30,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one channel per user
    },

    videos: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Video',
      }
    ],

    subscribed: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Channel',
      }
    ],

    subscribers: {
      count: {
        type: Number,
        default: 0,
      },
      channels: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Channel',
        }
      ]
    },

    interest: {
      type: Map,
      of: Number, // e.g., { science: 2, math: 5 }
      default: {},
    },
    profileImage: {
      type: String, // URL from Cloudinary
      default: ''
    },
    description: {
      type: String,
      default: ''
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Channel', ChannelSchema);
