const db = require('./index');

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS user_acgme_credentials (
    user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    acgme_username           VARCHAR(255) NOT NULL,
    acgme_password_encrypted TEXT NOT NULL,
    browser_cookies          TEXT,
    cookies_updated_at       TIMESTAMP,
    created_at               TIMESTAMP DEFAULT NOW(),
    updated_at               TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS case_submissions (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    procedure_date   VARCHAR(20),
    procedure_year   VARCHAR(5),
    selected_codes   TEXT,
    code_description TEXT,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message    TEXT,
    submitted_at     TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_case_submissions_user_id ON case_submissions(user_id);
  CREATE INDEX IF NOT EXISTS idx_case_submissions_status  ON case_submissions(status);
`;

// ALTER statements for columns added after initial deploy
const alterStatements = [
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS browser_cookies TEXT`,
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS cookies_updated_at TIMESTAMP`,
];

async function migrate() {
  try {
    await db.query(schema);
    for (const stmt of alterStatements) {
      await db.query(stmt).catch(e => {
        // Ignore if column already exists; log anything else
        if (!e.message.includes('already exists')) {
          console.warn('Migration ALTER warning:', e.message);
        }
      });
    }
    console.log('Database migration complete — all tables ready.');
  } catch (err) {
    console.error('Database migration failed:', err.message);
    // Don't crash the server — connection may still work for other queries
  }
}

module.exports = { migrate };
