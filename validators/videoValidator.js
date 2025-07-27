const Joi = require('joi');

exports.videoAddSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow('', null),
  tags: Joi.string().allow('', null), // comma-separated tags: "math,science"
  channelId: Joi.string().length(24).required()
});

exports.commentSchema = Joi.object({
  channelId: Joi.string().length(24).required(),
  comment: Joi.string().min(1).max(300).required()
});

exports.interactSchema = Joi.object({
  channelId: Joi.string().length(24).required()
});
