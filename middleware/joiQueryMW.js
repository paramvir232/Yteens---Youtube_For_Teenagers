/**
 * Joi validation for query strings.
 *
 * ── Do not copy joiValidationMW.js for this ───────────────────────────────────
 * That middleware validates req.body and relies on Joi's coercion being visible to the
 * handler, which works because req.body is a plain assignable property. req.query in
 * Express 5 is NOT: it is a lazily-evaluated getter with no setter, so
 *
 *     req.query = value;          // TypeError: Cannot set property query
 *
 * throws at runtime. (In Express 4 it was a normal property and this pattern was
 * everywhere, which is exactly why it is easy to reach for.)
 *
 * So the coerced, defaulted result is written to req.validatedQuery and handlers read
 * that. Reading req.query directly in a handler still works, but gives you the raw
 * strings with no defaults and no clamping - which for `limit` means an unbounded feed.
 */
const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query ?? {}, {
    abortEarly: true,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    return res.status(400).json({
      error: { code: 'INVALID_QUERY', message: error.details[0].message },
    });
  }

  req.validatedQuery = value;
  next();
};

module.exports = validateQuery;
