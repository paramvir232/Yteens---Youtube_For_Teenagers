/**
 * An error carrying an HTTP status and a stable machine-readable code.
 *
 * Existing routes return failures inline as res.status(4xx).json({ msg }), and errorMW
 * turns thrown errors into { success, message }. Neither carries a code a client can
 * branch on without string-matching the message - which breaks the moment the wording
 * changes.
 *
 * New /api/v2 endpoints throw these instead. errorMW is extended additively: when
 * err.code is present it is included in the body; otherwise the response is byte-identical
 * to what it has always been, so no existing route's output changes.
 */
class ApiError extends Error {
  /**
   * @param {string} [stage] which gate rejected the request, for moderation failures.
   *   Carried separately from `code` because the code says WHAT happened
   *   (CONTENT_REJECTED) while the stage says WHICH PART the user must change
   *   (text / image) — and the UI needs both to say anything useful.
   */
  constructor(statusCode, code, message, stage) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (stage) this.stage = stage;
  }

  static badRequest(code, message) {
    return new ApiError(400, code, message);
  }

  static notFound(code, message) {
    return new ApiError(404, code, message);
  }
}

module.exports = ApiError;
