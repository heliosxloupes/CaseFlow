-- Run once to set up database tables
-- On Railway: Settings → Database → Connect → run this in the query console

CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  name       VARCHAR(255),
  password_hash TEXT,
  is_admin   BOOLEAN NOT NULL DEFAULT FALSE,
  beta_invite_id INTEGER,
  beta_key_label VARCHAR(255),
  tos_accepted_at TIMESTAMP,
  tos_version VARCHAR(50),
  last_login_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_acgme_credentials (
  user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  acgme_username           VARCHAR(255) NOT NULL,
  acgme_password_encrypted TEXT NOT NULL,
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
  role             TEXT,
  site             TEXT,
  attending        TEXT,
  patient_type     TEXT,
  case_year        TEXT,
  notes            TEXT,
  procedures       JSONB,
  local_id         VARCHAR(50),
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
