const Joi = require('joi');

exports.videoAddSchema = Joi.object({
  topic: Joi.string().required(),
  count: Joi.number().min(1).max(10).default(1),
  channelId: Joi.string().length(24).required()
});

exports.commentSchema = Joi.object({
  channelId: Joi.string().length(24).required(),
  comment: Joi.string().min(1).max(300).required()
});

exports.interactSchema = Joi.object({
  channelId: Joi.string().length(24).required()
});
