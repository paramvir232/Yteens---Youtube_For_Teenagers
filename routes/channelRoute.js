const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Channel = require('../models/channelModel');
// ADDED: used by DELETE /delete/:id to remove the media, not just the database rows.
const { destroyCloudinaryAsset } = require('../util/cloudinaryAsset');
const User = require('../models/usersModel');
const catchAsync = require('../util/catchError');
const { channelCreateSchema } = require('../validators/channelValidator');
const joiValidate = require('../middleware/joiValidationMW')
const validateAfterUpload = require('../middleware/validateAfterUploadMW');
const Video = require('../models/videoModel');
const multer = require('multer');
// ADDED: identity now comes from the token, not from a field in the request body.
const { optionalAuth, requireAuth } = require('../middleware/authMW');
const { resolveActorChannel } = require('../middleware/actorMW');
const { ownsChannelParam, actorOf } = require('../middleware/ownershipMW');

/** See the matching note in videoRoute.js. */
const actor = [optionalAuth, resolveActorChannel({ required: true })];

const { imageStorage } = require('../config/cloudinary'); // your cloudinary setup
const upload = multer({ storage: imageStorage });


// // Create Channel
// router.post('/create1', joiValidate(channelCreateSchema) , catchAsync(async (req, res) => {
  
//   const { name, userId } = req.body;

//   // Make sure user exists
//   const user = await User.findById(userId);
//   if (!user) return res.status(404).json({ msg: 'User not found' });

//   // Check if Channel not Already exist
//   const existing = await Channel.findOne({ user: userId });
//   if (existing) return res.status(409).json({ msg: 'User already has a channel' });

//   // Creating Channel
//   const channel = await Channel.create({ name, user: userId });
//   res.status(201).json({ msg: 'Channel created', channel });
// }));

// Get All Channels
router.get('/', catchAsync(async (req, res) => {
  const channels = await Channel.find().populate('user', 'userName email');
  res.status(200).json(channels);
}));

// Get One Channel by ID
router.get('/getById/:id', catchAsync(async (req, res) => {
  const channel = await Channel.findById(req.params.id).populate('user', 'userName email');
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });
  res.status(200).json(channel);
}));

// Get channel By name
router.get('/getByName/:name', catchAsync(async (req, res) => {
  const channel = await Channel.find({ name:new RegExp(req.params.name, 'i') }).populate('user', 'userName email');

  if (!channel || channel.length === 0) {
    return res.status(404).json({ msg: 'Channel not found' });
  }

  res.status(200).json(channel);
}));


// Update Channel Info
router.put('/updateDetails/:id', ...actor, ownsChannelParam('id'), catchAsync(async (req, res) => {
  const body = req.body || {}; // ADDED: undefined on a multipart request

  // ADDED: an allowlist, because this used to pass the whole body to
  // findByIdAndUpdate. That let any caller rewrite `user` (reassigning the channel to
  // another account), `subscribers` (inventing a follower count) or `videos`
  // (attaching someone else's uploads). Only these three fields are editable.
  const updates = {};
  if (typeof body.name === 'string') updates.name = body.name;
  if (typeof body.description === 'string') updates.description = body.description;
  if (typeof body.profileImage === 'string') updates.profileImage = body.profileImage;

  const channel = await Channel.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });
  res.status(200).json({ msg: 'Channel updated', channel });
}));

// Subscribe to a Channel
router.post('/subscribe/:targetChannelId', ...actor, catchAsync(async (req, res) => {
  // ADDED: you subscribe as yourself. subscriberId used to be an unverified body field,
  // so anyone could subscribe anyone else's channel to anything - which also moved the
  // target's public subscriber count.
  const subscriberId = actorOf(req);
  const targetChannel = await Channel.findById(req.params.targetChannelId);
  const subscriberChannel = await Channel.findById(subscriberId);

  if (!targetChannel || !subscriberChannel) {
    return res.status(404).json({ msg: 'Channel not found' });
  }

  if (!targetChannel.subscribers.channels.includes(subscriberId)) {
    targetChannel.subscribers.channels.push(subscriberId);
    targetChannel.subscribers.count += 1;
    await targetChannel.save();

    subscriberChannel.subscribed.push(targetChannel._id);
    await subscriberChannel.save();
  }

  res.status(200).json({ msg: 'Subscribed successfully' });
}));

//  Unsubscribe from a Channel '/unsubscribe/:targetid'
router.post('/unsubscribe/:id', ...actor, catchAsync(async (req, res) => {
  const subscriberId = actorOf(req); // ADDED: was an unverified body field
  const targetChannel = await Channel.findById(req.params.id);
  const subscriberChannel = await Channel.findById(subscriberId);
  
  // Checking if Channel Exist
  if (!targetChannel || !subscriberChannel) {
    return res.status(404).json({ msg: 'Channel not found' });
  }

  // Removing subscriberId and Decrementing the count
  targetChannel.subscribers.channels = targetChannel.subscribers.channels.filter(
    id => id.toString() !== subscriberId
  );
  targetChannel.subscribers.count = targetChannel.subscribers.channels.length;
  await targetChannel.save();

  subscriberChannel.subscribed = subscriberChannel.subscribed.filter(
    id => id.toString() !== req.params.id
  );
  await subscriberChannel.save();

  res.status(200).json({ msg: 'Unsubscribed successfully' });
}));


// Delete Channel By ID
// ADDED: the single worst hole in the app - this was open to anyone who knew a channel
// id, and it cascades into deleting every video and Cloudinary asset the channel owns.
router.delete('/delete/:id', ...actor, ownsChannelParam('id'), catchAsync(async (req, res) => {
  const channelId = req.params.id;

  // Check if the channel exists
  const channel = await Channel.findById(channelId);
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });


  // ===========================================================================
  // ADDED (1 of 2): delete the media from Cloudinary as well as the DB rows.
  //
  // Video.deleteMany below removes the database records directly, bypassing
  // DELETE /video/delete/:id and its cleanup - so every video of every deleted
  // channel used to stay in Cloudinary forever. The channel's own profileImage
  // was never deleted either.
  //
  // The videos must be READ before they are deleted, because their Cloudinary
  // URLs are the only thing identifying the assets.
  // ===========================================================================
  const videos = await Video.find({ channel: channelId }).select('url thumbnailUrl').lean();

  const assets = [];
  for (const video of videos) {
    assets.push([video.url, 'video']);
    if (video.thumbnailUrl) assets.push([video.thumbnailUrl, 'thumbnail']);
  }
  if (channel.profileImage) assets.push([channel.profileImage, 'profileImage']);

  let destroyed = 0;
  for (const [url, label] of assets) {
    const result = await destroyCloudinaryAsset(url, label);
    if (result.deleted) destroyed += 1;
    else {
      console.warn(
        `[delete channel ${channelId}] ${label} not deleted (${result.reason}) - ` +
        `public_id ${result.publicId}`
      );
    }
  }
  console.log(
    `[delete channel ${channelId}] Cloudinary: ${destroyed}/${assets.length} assets removed`
  );
  // ==================== end of the Cloudinary cleanup ========================


  // Delete all videos linked to this channel
  await Video.deleteMany({ channel: channelId });


  // ===========================================================================
  // ADDED (2 of 2): remove this channel's id from everywhere else that holds it.
  //
  // Without this, deleting a channel left its id inside other channels'
  // subscribers.channels and subscribed arrays, and inside surviving videos'
  // likes.by, views.viewers and comments - so counts stayed inflated and
  // populate() produced nulls for a channel that no longer exists.
  //
  // Each update uses an aggregation pipeline so the array and its cached count
  // are recalculated together in one atomic step per document; a plain $pull
  // would strip the id but leave the count wrong.
  // ===========================================================================
  const oid = new mongoose.Types.ObjectId(channelId);

  const [subs, subscribedTo, likes, views, comments] = await Promise.all([
    // Other channels that had this one as a subscriber.
    Channel.updateMany({ 'subscribers.channels': oid }, [
      { $set: { 'subscribers.channels': { $setDifference: ['$subscribers.channels', [oid]] } } },
      { $set: { 'subscribers.count': { $size: '$subscribers.channels' } } }
    ]),
    // Other channels this one had subscribed to.
    Channel.updateMany({ subscribed: oid }, { $pull: { subscribed: oid } }),
    // Likes this channel left on videos that still exist.
    Video.updateMany({ 'likes.by': oid }, [
      { $set: { 'likes.by': { $setDifference: ['$likes.by', [oid]] } } },
      { $set: { 'likes.count': { $size: '$likes.by' } } }
    ]),
    // Views recorded against this channel.
    Video.updateMany({ 'views.viewers': oid }, [
      { $set: { 'views.viewers': { $setDifference: ['$views.viewers', [oid]] } } },
      { $set: { 'views.count': { $size: '$views.viewers' } } }
    ]),
    // Comments this channel posted on surviving videos.
    Video.updateMany({ 'comments.channel': oid }, { $pull: { comments: { channel: oid } } })
  ]);

  console.log(
    `[delete channel ${channelId}] references cleaned: ` +
    `${subs.modifiedCount} subscriber lists, ${subscribedTo.modifiedCount} subscription lists, ` +
    `${likes.modifiedCount} like lists, ${views.modifiedCount} view lists, ` +
    `${comments.modifiedCount} comment threads`
  );
  // ==================== end of the reference cleanup =========================


  // Delete the channel itself
  await Channel.findByIdAndDelete(channelId);

  res.status(200).json({ msg: '✅ Channel and all associated videos deleted successfully' });
}));

router.post(
  '/create',
  upload.single('profileImage'),
  // ADDED: you create a channel for yourself. userId used to be a body field, so a
  // caller could create a channel owned by someone else's account.
  requireAuth,
  (req, res, next) => {
    req.body = req.body || {};
    req.body.userId = req.auth.userId;
    next();
  },
  // ADDED: cleanup-aware validation. The profileImage is already in Cloudinary by this
  // point, so a plain 400 would leave it orphaned.
  validateAfterUpload(channelCreateSchema),
  catchAsync(async (req, res) => {
    const { name, userId, description } = req.body || {}; // ADDED: undefined-body guard

    // Check user exists
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    // Check if channel already exists
    const existing = await Channel.findOne({ user: userId });
    if (existing) return res.status(409).json({ msg: 'User already has a channel' });

    // Upload file
    const profileImage = req.file?.path || '';

    // if (profileImage==='') {
    //   res.send('Invalid');
    //   return;
    
  
    // }

    // res.send(`<h1>${profileImage?profileImage:'Invalid'}</h1>`)

    // Create channel
    const channel = await Channel.create({
      name,
      user: userId,
      profileImage, // Save Cloudinary URL
      description
    });

    res.status(201).json({ msg: 'Channel created', channel });
  })
);



module.exports = router;
