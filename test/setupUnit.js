/**
 * Setup for unit tests: block the network, nothing else.
 *
 * No database connection, so these run on a machine with no mongod and stay fast enough
 * to be worth running on every save.
 */
require('./helpers/noNetwork');

jest.setTimeout(5000);
