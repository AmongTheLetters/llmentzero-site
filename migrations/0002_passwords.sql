-- Optional passwords (Oct 16, 2026). Email codes remain the default and always work.
ALTER TABLE users ADD COLUMN password_hash TEXT;          -- NULL = no password. Versioned: pbkdf2-sha256$<iterations>$<pepper id>$<salt b64url>$<hash b64url>
ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
ALTER TABLE sessions ADD COLUMN auth_method TEXT;          -- 'code' | 'password' | 'code-only'
ALTER TABLE sessions ADD COLUMN code_verified_at INTEGER;  -- set when the session was created with a fresh email code
-- Optional password chosen on the sign-up form, held (already hashed) until the emailed code is entered.
ALTER TABLE login_codes ADD COLUMN pending_password_hash TEXT;
