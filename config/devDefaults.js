/**
 * Localhost defaults, and only while developing.
 *
 * Running the whole stack locally means setting a handful of variables that every
 * developer sets to the same value. Leaving them unset is not harmless: `resolveMongoUri`
 * falls through to `MONGODB_URI`, so a local run with `MONGODB_URI_LOCAL` unset reads and
 * writes PRODUCTION. These defaults remove that class of accident.
 *
 * The guard is the whole point. `devDefault` returns the fallback ONLY when
 * NODE_ENV === 'development'. In production and in tests it returns undefined, so the
 * existing "is not configured" errors still fire and a deploy that forgot a variable
 * still fails loudly instead of quietly talking to localhost.
 *
 * Each substitution is announced once, because a default nobody can see is how you end
 * up debugging the wrong database.
 */

const announced = new Set();

/**
 * @param {string} name  the variable's name, for the log line
 * @param {string} value the value to use while developing
 * @returns {string|undefined} the env value, the dev default, or undefined
 */
function devDefault(name, value) {
  const actual = process.env[name];
  if (actual && String(actual).trim()) return actual;

  if (process.env.NODE_ENV !== 'development') return undefined;

  if (!announced.has(name)) {
    announced.add(name);
    console.log(`[dev default] ${name} is not set, using ${value}`);
  }
  return value;
}

/**
 * A number from the environment, with a fallback that survives a bad value.
 *
 * `Number(process.env.X || 30)` looks like it falls back, and does for an unset or empty
 * value - but `Number('thirty')` is NaN, which passes straight through. A NaN rate limit
 * or token lifetime fails in a way that points nowhere near the typo that caused it.
 */
function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] ${name}="${raw}" is not a number, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Reset the "announced once" memory. Tests only. */
function __resetAnnounced() {
  announced.clear();
}

module.exports = { devDefault, numberFromEnv, __resetAnnounced };
