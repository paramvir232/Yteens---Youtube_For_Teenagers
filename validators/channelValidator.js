const Joi = require('joi');

exports.channelCreateSchema = Joi.object({
  name: Joi.string().min(2).max(30).required(),
  userId: Joi.string().length(24).required(), // Mongo ObjectId

  /**
   * `.allow('')` is load-bearing, not decoration.
   *
   * The bio is optional in the UI, and a multipart form has no way to express "absent"
   * for a field the client always appends — it sends `description=""`. Joi's
   * `string().optional()` accepts a MISSING key but rejects an EMPTY one, so every
   * person who left the bio blank got
   *
   *     400 "description" is not allowed to be empty
   *
   * which the app reported as "Connection to central server failed". A new account
   * could not create a channel at all, and so could never upload or join a community.
   */
  description: Joi.string().allow('').optional(),
});
