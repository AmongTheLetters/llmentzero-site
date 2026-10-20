-- Team accounts (Oct 19, 2026). One owner per team; each account can be on only one team.
-- Devices bought by the owner's account form the team's pool. Assigning devices to a member is
-- PERMANENT: the assignment stays with the member's account even if they leave or are removed.
-- A refund of an order still ends every device from that order, including assigned ones,
-- because each assignment points at the licence row (order) it was taken from.

CREATE TABLE teams (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_at     INTEGER NOT NULL
);

-- Current membership. user_id is UNIQUE, so an account can be on only one team (as owner or member).
CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- Email invites. Only a SHA-256 hash of the link token is stored. Single use, 7 days.
CREATE TABLE team_invites (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  email         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  accepted_by   TEXT REFERENCES users(id),
  cancelled_at  INTEGER
);
CREATE INDEX team_invites_team ON team_invites(team_id, created_at);
CREATE INDEX team_invites_email ON team_invites(email);

-- How many devices of each licence row have been assigned. The CHECK makes over-assigning
-- impossible: an UPDATE that would push it past `devices` fails and rolls back the whole batch.
ALTER TABLE licences ADD COLUMN assigned_devices INTEGER NOT NULL DEFAULT 0 CHECK (assigned_devices >= 0 AND assigned_devices <= devices);

-- Permanent assignments, taken from specific licence rows. Never deleted when a member leaves.
CREATE TABLE licence_assignments (
  id           TEXT PRIMARY KEY,
  licence_id   TEXT NOT NULL REFERENCES licences(id),
  team_id      TEXT NOT NULL REFERENCES teams(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  devices      INTEGER NOT NULL CHECK (devices > 0),
  assigned_by  TEXT NOT NULL REFERENCES users(id),
  assigned_at  INTEGER NOT NULL
);
CREATE INDEX licence_assignments_user ON licence_assignments(user_id);
CREATE INDEX licence_assignments_licence ON licence_assignments(licence_id);
CREATE INDEX licence_assignments_team ON licence_assignments(team_id);
