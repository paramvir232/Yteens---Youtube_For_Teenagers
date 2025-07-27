const Joi = require('joi');

exports.channelCreateSchema = Joi.object({
  name: Joi.string().min(2).max(30).required(),
  userId: Joi.string().length(24).required() // Mongo ObjectId
});
