const express = require('express');
const router = express.Router();
const Channel = require('../models/channelModel');
const User = require('../models/usersModel');
const catchAsync = require('../util/catchError');
const { channelCreateSchema } = require('../validators/channelValidator');
const joiValidate = require('../middleware/joiValidationMW')

// Create Channel
router.post('/', joiValidate(channelCreateSchema) , catchAsync(async (req, res) => {
  
  const { name, userId } = req.body;

  // Make sure user exists
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ msg: 'User not found' });

  const existing = await Channel.findOne({ user: userId });
  if (existing) return res.status(409).json({ msg: 'User already has a channel' });

  const channel = await Channel.create({ name, user: userId });
  res.status(201).json({ msg: 'Channel created', channel });
}));

// Get All Channels
router.get('/', catchAsync(async (req, res) => {
  const channels = await Channel.find().populate('user', 'userName email');
  res.status(200).json(channels);
}));

// Get One Channel by ID
router.get('/:id', catchAsync(async (req, res) => {
  const channel = await Channel.findById(req.params.id).populate('user', 'userName email');
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });
  res.status(200).json(channel);
}));

// Update Channel Info
router.put('/:id', catchAsync(async (req, res) => {
  const updates = req.body;
  const channel = await Channel.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!channel) return res.status(404).json({ msg: 'Channel not found' });
  res.status(200).json({ msg: 'Channel updated', channel });
}));

// Subscribe to a Channel
router.post('/:id/subscribe', catchAsync(async (req, res) => {
  const { subscriberId } = req.body; // Channel ID of who is subscribing
  const targetChannel = await Channel.findById(req.params.id);
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

//  Unsubscribe from a Channel
router.post('/:id/unsubscribe', catchAsync(async (req, res) => {
  const { subscriberId } = req.body;
  const targetChannel = await Channel.findById(req.params.id);
  const subscriberChannel = await Channel.findById(subscriberId);

  if (!targetChannel || !subscriberChannel) {
    return res.status(404).json({ msg: 'Channel not found' });
  }

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

module.exports = router;
