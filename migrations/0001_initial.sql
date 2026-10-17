-- LlmentZero accounts: initial schema (Cloudflare D1 / SQLite).
-- All times are Unix seconds (UTC). Emails are stored lower-cased.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  marketing_consent INTEGER NOT NULL DEFAULT 0,      -- CASL express consent, opt-in only
  marketing_consent_at INTEGER,
  created_at        INTEGER NOT NULL,
  last_sign_in_at   INTEGER,
  closed_at         INTEGER
);

-- One row per signed-in browser. Only a SHA-256 hash of the cookie value is stored.
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Pending email codes. Only a SHA-256 hash of the code is stored.
-- signup rows carry the clickwrap choices so acceptance is logged once the email is proven.
CREATE TABLE login_codes (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (purpose IN ('signin','signup')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  terms_ticked_at INTEGER,          -- when the unticked box was ticked and submitted
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  ip_hash       TEXT,
  user_agent    TEXT,
  next_path     TEXT
);
CREATE INDEX login_codes_email ON login_codes(email);
CREATE INDEX login_codes_expires ON login_codes(expires_at);

-- Clickwrap evidence. Kept for the life of the account plus 6 years.
CREATE TABLE terms_acceptances (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  email            TEXT NOT NULL,
  terms_version    TEXT NOT NULL,
  terms_sha256     TEXT NOT NULL,
  licence_version  TEXT NOT NULL,
  licence_sha256   TEXT NOT NULL,
  privacy_version  TEXT NOT NULL,
  privacy_sha256   TEXT NOT NULL,
  method           TEXT NOT NULL,     -- 'signup checkbox' | 're-accept checkbox'
  checkbox_label   TEXT NOT NULL,     -- exact wording shown
  accepted_at      INTEGER NOT NULL,  -- when the box was ticked and the form submitted
  recorded_at      INTEGER NOT NULL,  -- when the email was verified and the row written
  ip_hash          TEXT,
  user_agent       TEXT
);
CREATE INDEX terms_acceptances_user ON terms_acceptances(user_id, accepted_at);

-- Business / Deployment Licences bought on Payhip, matched to accounts by email.
CREATE TABLE licences (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  product_name  TEXT,
  licence_type  TEXT NOT NULL,          -- 'business' | 'deployment' | other product key
  devices       INTEGER NOT NULL DEFAULT 1,
  licence_key   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','partial_refund','revoked')),
  price_cents   INTEGER,
  currency      TEXT,
  purchased_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (order_id, product_id)
);
CREATE INDEX licences_email ON licences(email, status);

-- Skill files (no R2). Content is split into chunks of at most ~80 KB so each
-- INSERT stays under D1's statement size limit.
CREATE TABLE skills (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  tier          TEXT NOT NULL,
  version       TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL,          -- of the source file as stored
  canary_guid   TEXT NOT NULL,
  canary_words  TEXT NOT NULL,          -- comma-separated private code words
  published     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE skill_chunks (
  slug     TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  content  TEXT NOT NULL,
  PRIMARY KEY (slug, idx)
);

-- Download log. Kept 12 months.
CREATE TABLE downloads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  slug         TEXT NOT NULL,
  version      TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL,
  ip_hash      TEXT
);
CREATE INDEX downloads_user ON downloads(user_id, downloaded_at);
CREATE INDEX downloads_time ON downloads(downloaded_at);

-- Fixed-window counters (kept in D1, not KV, to stay inside KV's 1,000 writes/day).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Security and admin events. Kept 12 months.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  user_id    TEXT,
  detail     TEXT,
  ip_hash    TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
