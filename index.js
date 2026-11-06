/**
 * Server entry point.
 *
 * The app itself now lives in app.js so that tests can import it without starting a
 * listener or opening a database connection. This file does the two things only a real
 * server should do: connect to Mongo, then listen.
 *
 * One deliberate change from the original: the connection is awaited before listening.
 * It used to be fire-and-forget, so the server would accept traffic and return 500s for
 * every database-backed route while Mongo was still connecting - or forever, if the URI
 * was wrong, since the rejection was only logged.
 */
require('dotenv').config();

const app = require('./app');
const { connectDB } = require('./config/db');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Listening port ${PORT} ...`));
  })
  .catch((err) => {
    console.error('Could Not Connect to MongoDB ..', err);
    process.exit(1);
  });
