/**
 * Jest configuration.
 *
 * Two projects, because unit and integration tests have genuinely different needs and
 * conflating them makes the fast ones slow:
 *
 *   unit        - no database, no Express, no network. Pure functions and services with
 *                 their collaborators mocked. Runs in well under a second and needs no
 *                 mongod running, so it works on a machine that has never set up the
 *                 project. If something is hard to test here it has a dependency it
 *                 should not have.
 *   integration - a real local mongod and the real Express app via supertest, with only
 *                 outbound HTTP mocked. Asserts status codes, response shapes and the
 *                 resulting database state.
 *
 * runInBand (set in the npm script) is deliberate for now: the integration suite shares
 * one mongod and serial execution makes failures far easier to read. Each run still gets
 * its own database name, so parallel workers would also be safe.
 *
 * scripts/ is excluded everywhere. pipelineLiveCheck.js and deleteRouteLiveCheck.js
 * upload real files to Cloudinary and call the real moderation services; they are run by
 * hand and must never be part of `npm test`.
 */
const base = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/'],
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/test/setupUnit.js'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/test/setupIntegration.js'],
    },
  ],
  collectCoverageFrom: [
    '**/*.js',
    '!node_modules/**',
    '!scripts/**',
    '!test/**',
    '!jest.config.js',
    '!config/swaggerConfig.js',
  ],
};
