const express = require('express');
const router = express.Router();
const Video = require('../models/videoModel');
const Channel = require('../models/channelModel');
const catchAsync = require('../util/catchError');
const { fetchYouTubeVideos } = require('../util/youtubeFetch');
const joiValidate = require('../middleware/joiValidationMW')
const { videoAddSchema } = require('../validators/videoValidator');
const multer = require('multer');
const { storage } = require('../config/cloudinary');
const upload = multer({ storage });

// Add video on YouTube
router.post('/upload', joiValidate(videoAddSchema),upload.single('video'), catchAsync(async (req, res) => {
  const { title, description, tags, channelId } = req.body;

    // Check channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) return res.status(404).json({ msg: 'Channel not found' });

    // Check file was uploaded
    if (!req.file || !req.file.path) {
      return res.status(400).json({ msg: 'No video uploaded' });
    }

    // Convert tag string to array
    const tagArray = tags
      ? tags.split(',').map(tag => tag.trim().toLowerCase())
      : [];

    // Create and save video
    const newVideo = await Video.create({
      title,
      description,
      tags: tagArray,
      url: req.file.path,
      channel: channel._id
    });

    // Add video to channel
    channel.videos.push(newVideo._id);
    await channel.save();

    res.status(201).json({
      msg: '✅ Video uploaded and saved successfully',
      video: newVideo
    });
  })
);

//  Delete video by ID
router.delete('/delete/:id', catchAsync(async (req, res) => {
  const videoId = req.params.id;
  const { channelId } = req.body;

  if (!channelId) {
    return res.status(400).json({ msg: 'Channel ID is required' });
  }

  const video = await Video.findById(videoId);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });

  // 🔄 Remove video from channel's videos array
  channel.videos = channel.videos.filter(id => id.toString() !== videoId);


  await channel.save();


  // 🗑 Delete from DB
  await Video.findByIdAndDelete(videoId);

  res.status(200).json({ msg: '✅ Video deleted and channel updated' });
}));


// Get all videos
router.get('/', catchAsync(async (req, res) => {
  const videos = await Video.find().populate('channel', 'name');
  res.status(200).json(videos);
}));

// Get videos by tag/topic
router.get('/tag/:tag', catchAsync(async (req, res) => {
  const videos = await Video.find({ tags: req.params.tag }).populate('channel', 'name');
  res.status(200).json(videos);
}));

// Like a video (no duplicate)
router.post('/:id/like', catchAsync(async (req, res) => {
  const { channelId } = req.body;
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const alreadyLiked = video.likes.by.some(id => id.toString() === channelId);

  if (!alreadyLiked) {
    video.likes.by.push(channelId);
    video.likes.count = video.likes.by.length;
    await video.save();
    return res.status(200).json({ msg: 'Video liked' });
  }

  res.status(200).json({ msg: 'Already liked' });
}));

// Unlike a video
router.post('/:id/unlike', catchAsync(async (req, res) => {
  const { channelId } = req.body;
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const before = video.likes.by.length;
  video.likes.by = video.likes.by.filter(id => id.toString() !== channelId);
  video.likes.count = video.likes.by.length;

  if (before !== video.likes.count) {
    await video.save();
    return res.status(200).json({ msg: 'Video unliked' });
  }

  res.status(200).json({ msg: 'Already unliked' });
}));

// Comment on a video
router.post('/:id/comment', catchAsync(async (req, res) => {
  const { channelId, comment } = req.body;
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  video.comments.push({ channel: channelId, comment });
  await video.save();

  res.status(201).json({ msg: 'Comment added' });
}));

// Track a view 
router.post('/:id/view', catchAsync(async (req, res) => {
  const { channelId } = req.body;
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const alreadyViewed = video.views.viewers.some(id => id.toString() === channelId);

  if (!alreadyViewed) {
    video.views.viewers.push(channelId);
    video.views.count = video.views.viewers.length;
    await video.save();
    return res.status(200).json({ msg: 'New view counted' });
  }

  res.status(200).json({ msg: 'Already viewed, not counted again' });
}));

module.exports = router;
