const express = require('express');
const router = express.Router();
const Video = require('../models/videoModel');
const Channel = require('../models/channelModel');
const catchAsync = require('../util/catchError');
const fetchYouTubeVideosByTopics  = require('../util/youtubeFetch');
const joiValidate = require('../middleware/joiValidationMW')
const { videoAddSchema,videoUpdateSchema } = require('../validators/videoValidator');
const multer = require('multer');
const { storage } = require('../config/cloudinary');
const upload = multer({ storage });

// Upload video 
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

//Update Video By ID
router.put('/update/:id',joiValidate(videoUpdateSchema) ,catchAsync(async (req, res) => {
  const { title, description, tags } = req.body;

  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  if (title) video.title = title;
  if (description !== undefined) video.description = description;

  if (tags) {
    video.tags = tags
      .split(',')
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag.length > 0);
  }

  await video.save();

  res.status(200).json({
    msg: '✅ Video updated successfully',
    video
  });
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
router.post('/likeVideo/:id', catchAsync(async (req, res) => {
  const { channelId } = req.body;

  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const alreadyLiked = video.likes.by.some(
    id => id.toString() === channelId
  );

  if (!alreadyLiked) {
    video.likes.by.push(channelId);
    video.likes.count = video.likes.by.length;
    await video.save();
    return res.status(200).json({ msg: 'Video liked!' });
  }

  res.status(200).json({ msg: 'Already liked' });
}));

// Unlike a video
router.post('/unlikeVideo/:id', catchAsync(async (req, res) => {
  const { channelId } = req.body;

  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const before = video.likes.by.length;
  video.likes.by = video.likes.by.filter(
    id => id.toString() !== channelId
  );
  video.likes.count = video.likes.by.length;

  if (before !== video.likes.count) {
    await video.save();
    return res.status(200).json({ msg: 'Video unliked' });
  }

  res.status(200).json({ msg: 'Already unliked' });
}));

// Comment on a video
router.post('/comment/:id', catchAsync(async (req, res) => {
  const { channelId, comment } = req.body;
  const videoId = req.params.id;

  if (!channelId || !comment) {
    return res.status(400).json({ msg: 'channelId and comment are required' });
  }

  const video = await Video.findById(videoId);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const newComment = {
    channel: channelId,
    comment,
    at: new Date()
  };

  video.comments.push(newComment);
  await video.save();

  res.status(201).json({ msg: 'Comment added', comment: newComment });
}));

// Delete Comment
router.delete('/:id/deleteComment/:commentId', catchAsync(async (req, res) => {
  const { id: videoId, commentId } = req.params;

  const video = await Video.findById(videoId);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const initialLength = video.comments.length;

  video.comments = video.comments.filter(c => c._id.toString() !== commentId);

  if (video.comments.length === initialLength) {
    return res.status(404).json({ msg: 'Comment not found' });
  }

  await video.save();
  res.status(200).json({ msg: '✅ Comment deleted' });
}));


// 🔍 Search videos by title or tags
router.get('/search/:query', catchAsync(async (req, res) => {
  const query = req.params.query;

  const videos = await Video.find({
    $or: [
      { title: { $regex: query, $options: 'i' } },   // Match in title
      { tags: { $regex: query, $options: 'i' } }     // Match in tags
    ]
  });

  if (videos.length === 0) {
    return res.status(404).json({ msg: 'No videos found matching that topic' });
  }

  res.status(200).json({ msg: 'Videos found', results: videos });
}));

// Get Local Video Recomandations
router.get('/recommend/:channelId/:count', catchAsync(async (req, res) => {
  const { channelId, count } = req.params;

  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });

  const interest = channel.interest || {};
  const totalWeight = Array.from(interest.values()).reduce((acc, val) => acc + val, 0);

  if (totalWeight === 0) {
    return res.status(200).json({ msg: 'No interests yet', videos: [] });
  }

  const tags = Array.from(interest.entries());

  const videoPromises = tags.map(([tag, freq]) => {
    const tagCount = Math.round((freq / totalWeight) * count);

    return Video.find({
      tags: tag,
      channel: { $ne: channelId } // 👈 exclude your own videos
    }).limit(tagCount);
  });

  const videoResults = await Promise.all(videoPromises);
  const flattened = videoResults.flat().slice(0, count);

  res.status(200).json({
    msg: `Recommended ${flattened.length} videos (excluding your own)`,
    videos: flattened
  });
}));


// Get Youtube Video Recomandations
router.get('/recommend-youtube/:channelId/:count', catchAsync(async (req, res) => {
  const { channelId, count } = req.params;

  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });

  const interest = channel.interest || {};
  const totalWeight = Array.from(interest.values()).reduce((acc, val) => acc + val, 0);

  if (totalWeight === 0) {
    return res.status(200).json({ msg: 'No interests yet', videos: [] });
  }

  // 🔁 Build topicMap like { math: 3, science: 2 }
  const topicMap = {};
  for (let [tag, freq] of interest.entries()) {
    const portion = Math.round((freq / totalWeight) * count);
    if (portion > 0) topicMap[tag] = portion;
  }

  const videos = await fetchYouTubeVideosByTopics(topicMap);

  res.status(200).json({
    msg: `Fetched ${videos.length} YouTube videos`,
    videos
  });
}));


// OnClick Video
router.post('/onClick/:id', catchAsync(async (req, res) => {
  const { channelId } = req.body;

  if (!channelId) return res.status(400).json({ msg: 'channelId is required' });

  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });

  //  Track view if not already viewed
  const alreadyViewed = video.views.viewers.some(id => id.toString() === channelId);
  if (!alreadyViewed) {
    video.views.viewers.push(channelId);
    video.views.count = video.views.viewers.length;
  }

  //  Boost interest from video tags
  video.tags.forEach(tag => {
    const current = channel.interest.get(tag) || 0;
    channel.interest.set(tag, current + 1);
  });

  await Promise.all([video.save(), channel.save()]);

  res.status(200).json({ msg: 'View recorded and interest boosted' });
}));

// Get Video by Id
router.get('/get/:id', catchAsync(async (req, res) => {
  const video = await Video.findById(req.params.id).populate('channel', 'name');

  if (!video) {
    return res.status(404).json({ msg: 'Video not found' });
  }

  res.status(200).json({
    msg: '✅ Video details fetched',
    video
  });
}));

module.exports = router;
