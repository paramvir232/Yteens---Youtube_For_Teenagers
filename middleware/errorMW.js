
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);

  const statusCode = err.statusCode || 500;
  const errorMessage = err.message || 'Internal Server Error';

  // Errors thrown by /api/v2 routes carry an ApiError code, and those routes use an
  // { error: { code, message } } envelope so clients can branch on the code instead of
  // string-matching the message. Everything else keeps the exact body this handler has
  // always returned - the shape existing clients already depend on.
  if (err.code && typeof err.code === 'string') {
    return res.status(statusCode).json({
      error: {
        code: err.code,
        message: errorMessage,
        // Present only for moderation rejections. The raw scores are deliberately NOT
        // included — they would let anyone probe where the thresholds sit.
        ...(err.stage ? { stage: err.stage } : {}),
      },
    });
  }

  res.status(statusCode).json({
    success: false,
    message: errorMessage,
  });
};

module.exports = errorHandler;
