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

  CREATE TABLE IF NOT EXISTS user_milestones_cache (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    report_name  VARCHAR(100) NOT NULL,
    report_data  JSONB NOT NULL,
    generated_at TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, report_name)
  );
`;

// ALTER statements for columns added after initial deploy
const alterStatements = [
  // v1 — ACGME cookie storage
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS browser_cookies TEXT`,
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS cookies_updated_at TIMESTAMP`,
  // v2 — multi-user auth
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
  // v2 — full case data storage
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS role VARCHAR(50)`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS site VARCHAR(100)`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS attending VARCHAR(100)`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS patient_type VARCHAR(20)`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS case_year VARCHAR(10)`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS procedures JSONB`,
  `ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS local_id VARCHAR(50)`,
  // v3 — milestones snapshot cache
  `CREATE TABLE IF NOT EXISTS user_milestones_cache (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      report_name VARCHAR(100) NOT NULL,
      report_data JSONB NOT NULL,
      generated_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, report_name)
    )`,
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
