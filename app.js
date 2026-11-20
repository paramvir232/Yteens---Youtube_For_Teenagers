/**
 * The Express app, with no database connection and no listener.
 *
 * Split out of index.js so that supertest can import a ready-to-use app object.
 * Previously index.js built the app, connected to Mongo and called listen() in one
 * module, which meant requiring it from a test started a real server and opened a real
 * connection to whatever MONGODB_URI happened to be set to. index.js keeps its name and
 * its listen(); it just delegates the building to here.
 *
 * Middleware order matters and three things were in the wrong place before the move:
 *
 *   1. compression() was registered AFTER every router, so it never compressed a single
 *      API response - only the two routes declared below it. It now sits above the
 *      routers, where it does what it was added to do.
 *   2. app.get('/') and app.get('/wake-up') were registered AFTER app.use(errorMW).
 *      Express runs the stack in order, so an error thrown by either of those handlers
 *      skipped the error middleware entirely and fell through to Express's default HTML
 *      error page. They now sit above it.
 *   3. cors() was registered after /docs, so the Swagger UI route was not covered by it.
 *
 * All three are behaviour-preserving for requests that already worked. What is
 * deliberately NOT changed: the response-shape mismatch between route handlers ({msg})
 * and errorMW ({success, message}). Clients depend on both.
 */
const Express = require('express');
const swaggerUI = require('swagger-ui-express');
const cors = require('cors');
const compression = require('compression');

const swaggerSpec = require('./config/swaggerConfig');
const errorMW = require('./middleware/errorMW');

const app = Express();

app.use(cors());
app.use(Express.json());
app.use(compression());

app.use('/docs', swaggerUI.serve, swaggerUI.setup(swaggerSpec));

// Routers
app.use('/user', require('./routes/usersRoute'));
app.use('/channel', require('./routes/channelRoute'));
app.use('/video', require('./routes/videoRoute'));
// Several routers share the /api/v2 mount. Express merges them in registration order,
// so their sub-paths must stay disjoint: uploadV2Route owns /upload, feedRoute owns
// /feed.
app.use('/api/v2', require('./routes/uploadV2Route'));
app.use('/api/v2', require('./routes/uploadJobsRoute'));
app.use('/api/v2', require('./routes/feedRoute'));
app.use('/api/v2/auth', require('./routes/authRoute'));
app.use('/api/v2/communities', require('./routes/communityRoute'));

app.get('/', (req, res) => {
  res.status(200).send('<h1>WELCOME TO YTEEN API</h1>');
});

app.get('/wake-up', (req, res) => {
  res.status(200).send('Backend is awake!');
});

// Final error-handling middleware. Must stay last.
app.use(errorMW);

module.exports = app;
