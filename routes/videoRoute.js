const express = require('express');
const router = express.Router();
const Video = require('../models/videoModel');
const Channel = require('../models/channelModel');
const catchAsync = require('../util/catchError');
const fetchYouTubeVideosByTopics  = require('../util/youtubeFetch');
const joiValidate = require('../middleware/joiValidationMW')
// ADDED: validation for upload routes, which must run after multer and clean up on reject.
const validateAfterUpload = require('../middleware/validateAfterUploadMW');
const { videoAddSchema,videoUpdateSchema } = require('../validators/videoValidator');

// ADDED: identity now comes from the token, not from a field in the request body.
const { optionalAuth, requireAuth, resolveChannel } = require('../middleware/authMW');
const { resolveActorChannel } = require('../middleware/actorMW');
const { ownsVideoParam, canDeleteComment, actorOf } = require('../middleware/ownershipMW');

/**
 * The guard every write on this router now carries.
 *
 * optionalAuth verifies the token if one is present (a BAD token is still an error);
 * resolveActorChannel then turns it into req.actorChannelId, or answers 401 when there
 * is no token at all. The body's channelId is ignored whenever a token is present, so a
 * client cannot opt back into the old, unverified path by also sending the field.
 */
const actor = [optionalAuth, resolveActorChannel({ required: true })];

const { storage, imageStorage } = require('../config/cloudinary');
// ADDED: used by DELETE /delete/:id to remove the media, not just the database row.
const { destroyVideoAsset } = require('../util/cloudinaryAsset');
const multer = require('multer');
const uploadVideo = multer({ storage });
const uploadImage = multer({ storage: imageStorage });

// Upload both video & thumbnail
router.post(
  '/upload',
  // ADDED: multer now runs BEFORE validation, and validation is the cleanup-aware kind.
  //
  // It used to be the other way round. On a multipart request req.body does not exist
  // until multer has parsed the form, so the validator saw `undefined`, which Joi
  // accepts - meaning this route accepted uploads with no title and no channelId and
  // only failed later, if at all. Validating after multer makes the schema real.
  //
  // validateAfterUpload rather than joiValidate because by this point the file is
  // already in Cloudinary; a plain 400 would leave it orphaned.
  multer({ storage }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
  ]),
  ...actor,
  // ADDED: the authenticated channel overwrites whatever the form said, BEFORE the
  // schema runs - so the validator still sees the channelId it requires, and a form
  // field naming someone else's channel is simply discarded rather than rejected.
  (req, res, next) => {
    req.body = req.body || {};
    req.body.channelId = actorOf(req);
    next();
  },
  validateAfterUpload(videoAddSchema),
  catchAsync(async (req, res) => {
    const { title, description, tags, channelId } = req.body || {}; // ADDED: undefined-body guard

    // Check channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) return res.status(404).json({ msg: 'Channel not found' });

    // Validate video upload
    if (!req.files || !req.files.video || !req.files.video[0].path) {
      return res.status(400).json({ msg: 'No video uploaded' });
    }

    // Prepare thumbnail URL if provided
    let thumbnailUrl = null;
    if (req.files.thumbnail && req.files.thumbnail[0].path) {
      thumbnailUrl = req.files.thumbnail[0].path.replace(/\.mp4$/, '.jpg');
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
      url: req.files.video[0].path,
      thumbnailUrl, // Will be null if no thumbnail
      channel: channel._id
    });

    // Add video to channel
    channel.videos.push(newVideo._id);
    await channel.save();

    res.status(201).json({
      msg: '✅ Video and thumbnail uploaded successfully',
      video: newVideo
    });
  })
);

//  Delete video by ID
router.delete('/delete/:id', ...actor, ownsVideoParam('id'), catchAsync(async (req, res) => {
  const videoId = req.params.id;
  // ADDED: the owning channel comes from the token. It used to come from the body and
  // was never checked against the video, so any caller could delete any video by
  // naming their own channel - or anyone else's.
  const channelId = actorOf(req);

  const video = req.video; // loaded and ownership-checked by ownsVideoParam

  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });

  // 🔄 Remove video from channel's videos array
  channel.videos = channel.videos.filter(id => id.toString() !== videoId);


  await channel.save();


  // ===========================================================================
  // ADDED: also delete the media from Cloudinary.
  //
  // Until this was added, deleting a video removed only the database row. The
  // video and its thumbnail stayed in Cloudinary forever, consuming storage that
  // nothing would ever reclaim, because videoModel stores no public_id and so
  // nothing could identify the orphans afterwards.
  //
  // Deliberately before the DB delete, and deliberately non-fatal: if Cloudinary
  // cannot be reached the row is still removed, because that is what the caller
  // asked for. The failure is logged so the orphan can be reconciled by hand.
  // ===========================================================================
  const videoDestroy = await destroyVideoAsset(video.url, 'video');
  const thumbDestroy = video.thumbnailUrl
    ? await destroyVideoAsset(video.thumbnailUrl, 'thumbnail')
    : null;

  if (!videoDestroy.deleted) {
    console.warn(
      `[delete] video ${videoId}: Cloudinary asset not deleted (${videoDestroy.reason}) ` +
      `- public_id ${videoDestroy.publicId}`
    );
  }
  if (thumbDestroy && !thumbDestroy.deleted) {
    console.warn(
      `[delete] video ${videoId}: Cloudinary thumbnail not deleted (${thumbDestroy.reason}) ` +
      `- public_id ${thumbDestroy.publicId}`
    );
  }
  // ======================= end of the Cloudinary cleanup ======================


  // 🗑 Delete from DB
  await Video.findByIdAndDelete(videoId);

  res.status(200).json({ msg: '✅ Video deleted and channel updated' });
}));

//Update Video By ID
// ADDED: this route had NO identity check of any kind - not even an unverified
// channelId in the body. Anyone who knew a video's id could retitle it.
router.put('/update/:id', ...actor, ownsVideoParam('id'), joiValidate(videoUpdateSchema), catchAsync(async (req, res) => {
  const { title, description, tags } = req.body || {}; // ADDED: undefined on multipart

  const video = req.video;

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
router.post('/likeVideo/:id', ...actor, catchAsync(async (req, res) => {
  // ADDED: the liking channel is the authenticated one. It used to be whatever the
  // body said, so anyone could like a video as anyone else.
  const channelId = actorOf(req);

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
router.post('/unlikeVideo/:id', ...actor, catchAsync(async (req, res) => {
  const channelId = actorOf(req);

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
router.post('/comment/:id', ...actor, catchAsync(async (req, res) => {
  // ADDED: the comment is attributed to the authenticated channel, never to a body
  // field - impersonation in a comment thread is the most visible form of this bug.
  const { comment } = req.body || {}; // ADDED: undefined on multipart
  const channelId = actorOf(req);
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
router.delete('/:id/deleteComment/:commentId', ...actor, catchAsync(async (req, res) => {
  const { id: videoId, commentId } = req.params;

  const video = await Video.findById(videoId);
  if (!video) return res.status(404).json({ msg: 'Video not found' });

  const comment = video.comments.find(c => c._id.toString() === commentId);
  if (!comment) return res.status(404).json({ msg: 'Comment not found' });

  // ADDED: this route used to delete any comment for any caller. A comment belongs to
  // its author and sits on someone's video, so either of those two may remove it -
  // and nobody else.
  if (!canDeleteComment(comment, video, actorOf(req))) {
    return res.status(403).json({
      error: { code: 'NOT_OWNER', message: 'You can only delete your own comments.' },
    });
  }

  video.comments = video.comments.filter(c => c._id.toString() !== commentId);

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
router.post('/onClick/:id', ...actor, catchAsync(async (req, res) => {
  const channelId = actorOf(req); // ADDED: was an unverified body field

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
