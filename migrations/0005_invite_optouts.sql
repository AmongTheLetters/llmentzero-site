-- CASL unsubscribe for team invites (Oct 20, 2026).
-- A person who asks not to get team invites is stored only as a keyed hash of their email address
-- (HMAC with IP_HASH_KEY, prefix "invite-optout:"), never the address itself.
CREATE TABLE invite_optouts (
  email_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
