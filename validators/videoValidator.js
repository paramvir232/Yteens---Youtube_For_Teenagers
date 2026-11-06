const Joi = require('joi');

exports.videoAddSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow('', null),
  tags: Joi.string().allow('', null), // comma-separated tags: "math,science"
  channelId: Joi.string().length(24).required()
});

// POST /api/v2/upload. Same fields as videoAddSchema - the moderated route accepts an
// identical body so the client only has to change the URL.
exports.uploadV2Schema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow('', null),
  tags: Joi.string().allow('', null), // comma-separated tags: "math,science"
  channelId: Joi.string().length(24).required()
});

exports.videoUpdateSchema = Joi.object({
  title: Joi.string(),
  description: Joi.string().allow('', null),
  tags: Joi.string().allow('', null) // comma-separated string: "math,science"
});

exports.commentSchema = Joi.object({
  channelId: Joi.string().length(24).required(),
  comment: Joi.string().min(1).max(300).required()
});

exports.interactSchema = Joi.object({
  channelId: Joi.string().length(24).required()
});
