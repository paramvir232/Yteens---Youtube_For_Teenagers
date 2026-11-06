const Channel = require('../models/channelModel');

/**
 * Work out which channel is acting, preferring the token and falling back to the body.
 *
 * ── The problem this exists to retire ────────────────────────────────────────
 * Every write in this app identifies its actor with a `channelId` in the request body,
 * which the server trusts completely. There is no verification, so anyone can act as
 * anyone: like as another channel, comment as another channel, upload to a channel they
 * do not own. It is not a subtle hole.
 *
 * It also cannot simply be deleted. Every deployed client sends exactly that, and
 * removing the fallback would break all of them at once.
 *
 * ── The bridge ───────────────────────────────────────────────────────────────
 * When a valid token is present, the body's channelId is IGNORED — not merged, not
 * preferred, ignored. A client that sends both gets the authenticated channel, so a
 * compromised client cannot opt back into the insecure path by also sending a body
 * field. That property is what makes this a real fix rather than a preference.
 *
 * When no token is present, the body is used as before, and the response carries
 * Deprecation and Sunset headers so the legacy path is visible in client logs and in
 * any proxy that surfaces them.
 *
 * Once traffic shows no legacy use, LEGACY_ACTOR_FALLBACK=false turns the fallback into
 * a 401. One environment variable, no code deleted, instantly reversible.
 */

// ── The flip ─────────────────────────────────────────────────────────────────
// This defaulted to ON while the frontend had no tokens to send. It now does, so the
// default is OFF: a request with no token is a 401, which is what makes these routes
// actually protected rather than merely able to identify a caller.
//
// Setting LEGACY_ACTOR_FALLBACK=true restores the old behaviour without a code change
// or a deploy. That matters more than tidiness here: this is the one change in the
// project that can lock every user out, and the way back has to be a single variable.
const FALLBACK_ENABLED = () => process.env.LEGACY_ACTOR_FALLBACK === 'true';

// Roughly when the fallback is expected to be switched off. Advisory only; it exists so
// the header carries a date rather than a vague "soon".
const SUNSET = 'Wed, 31 Dec 2026 23:59:59 GMT';

const resolveActorChannel = ({ required = true } = {}) => async (req, res, next) => {
  try {
    if (req.auth) {
      const channel = await Channel.findOne({ user: req.auth.userId }).select('_id').lean();
      if (!channel) {
        if (!required) return next();
        return res.status(403).json({
          error: { code: 'NO_CHANNEL', message: 'Create a channel before doing this.' },
        });
      }
      req.actorChannelId = String(channel._id);
      req.actorSource = 'token';
      return next();
    }

    const fromBody = req.body?.channelId || req.body?.subscriberId;
    if (fromBody && FALLBACK_ENABLED()) {
      res.set('Deprecation', 'true');
      res.set('Sunset', SUNSET);
      res.set('Link', '</api/v2/auth/login>; rel="deprecation"');
      req.actorChannelId = String(fromBody);
      req.actorSource = 'legacy-body';
      return next();
    }

    if (!required) return next();

    return res.status(401).json({
      error: {
        code: 'TOKEN_MISSING',
        message: 'Sign in to continue.',
      },
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = { resolveActorChannel };
