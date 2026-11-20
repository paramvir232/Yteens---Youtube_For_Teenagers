/**
 * Make any unmocked axios call fail loudly.
 *
 * Tests already mock services/moderationClients.js, but that only covers calls routed
 * through it. If someone later adds an axios call elsewhere - a new moderation endpoint,
 * an analytics ping, a retry helper - the suite would quietly start spending real quota
 * against the Hugging Face Spaces and Groq, and the first sign would be a bill or a
 * rate-limit rather than a failing test.
 *
 * Throwing turns that into an immediate failure that names the URL that was called.
 */
jest.mock('axios', () => {
  const explode = (...args) => {
    const target = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    throw new Error(
      `NETWORK ACCESS IN TEST: axios call to "${target}". Tests must not reach the ` +
      'network. Mock services/moderationClients.js, or add a mock for whatever module ' +
      'made this call.'
    );
  };

  const instance = {
    get: explode,
    post: explode,
    put: explode,
    patch: explode,
    delete: explode,
    head: explode,
    request: explode,
    interceptors: {
      request: { use: () => {}, eject: () => {} },
      response: { use: () => {}, eject: () => {} },
    },
    defaults: { headers: { common: {} } },
  };

  const axios = Object.assign(explode, instance, {
    create: () => instance,
    isAxiosError: () => false,
  });
  axios.default = axios;
  return axios;
});
