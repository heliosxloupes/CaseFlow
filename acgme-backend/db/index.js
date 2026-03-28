const { Pool } = require('pg');

// Railway internal networking (*.railway.internal) does NOT use SSL.
// External/public connections require SSL with self-signed cert tolerance.
const dbUrl = process.env.DATABASE_URL || '';
const useSSL = dbUrl.includes('railway.internal') ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: dbUrl,
  ssl: useSSL,
  connectionTimeoutMillis: 10000,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
