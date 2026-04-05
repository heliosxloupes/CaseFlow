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

  CREATE TABLE IF NOT EXISTS beta_invites (
    id                 SERIAL PRIMARY KEY,
    invite_key         VARCHAR(120) UNIQUE NOT NULL,
    label              VARCHAR(255),
    allowed_email      VARCHAR(255),
    claimed_email      VARCHAR(255),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at            TIMESTAMP,
    expires_at         TIMESTAMP,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    notes              TEXT,
    created_at         TIMESTAMP DEFAULT NOW(),
    updated_at         TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS error_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email   VARCHAR(255),
    source       VARCHAR(80) NOT NULL,
    severity     VARCHAR(20) NOT NULL DEFAULT 'error',
    message      TEXT NOT NULL,
    stack        TEXT,
    route        VARCHAR(255),
    method       VARCHAR(16),
    context_json JSONB,
    created_at   TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email   VARCHAR(255),
    event_type   VARCHAR(80) NOT NULL,
    message      TEXT,
    context_json JSONB,
    created_at   TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_beta_invites_invite_key ON beta_invites(invite_key);
  CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON error_logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id, created_at DESC);
`;

// ALTER statements for columns added after initial deploy
const alterStatements = [
  // v1 — ACGME cookie storage
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS browser_cookies TEXT`,
  `ALTER TABLE user_acgme_credentials ADD COLUMN IF NOT EXISTS cookies_updated_at TIMESTAMP`,
  `CREATE TABLE IF NOT EXISTS beta_invites (
      id SERIAL PRIMARY KEY,
      invite_key VARCHAR(120) UNIQUE NOT NULL,
      label VARCHAR(255),
      allowed_email VARCHAR(255),
      claimed_email VARCHAR(255),
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_at TIMESTAMP,
      expires_at TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
  // v2 — multi-user auth
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_invite_id INTEGER REFERENCES beta_invites(id) ON DELETE SET NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_key_label VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMP`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_version VARCHAR(50)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`,
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
  `CREATE TABLE IF NOT EXISTS error_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_email VARCHAR(255),
      source VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'error',
      message TEXT NOT NULL,
      stack TEXT,
      route VARCHAR(255),
      method VARCHAR(16),
      context_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_email VARCHAR(255),
      event_type VARCHAR(80) NOT NULL,
      message TEXT,
      context_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS label VARCHAR(255)`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS allowed_email VARCHAR(255)`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS claimed_email VARCHAR(255)`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS used_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS used_at TIMESTAMP`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
  // v4 — multi-specialty support
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty VARCHAR(60) DEFAULT 'plastic-surgery'`,
  `CREATE TABLE IF NOT EXISTS user_cpt_codes (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      codes      JSONB NOT NULL DEFAULT '[]',
      synced_at  TIMESTAMP NOT NULL DEFAULT NOW()
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
