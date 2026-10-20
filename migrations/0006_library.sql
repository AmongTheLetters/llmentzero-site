-- Skill library at scale (Oct 20, 2026). ADDITIVE ONLY: new columns have defaults, nothing is
-- dropped, renamed or rewritten, and the canary columns and skill_chunks are not touched.
-- See ../LIBRARY-UX-PLAN.md.
--
-- Writers must UPSERT skills (INSERT ... ON CONFLICT(slug) DO UPDATE), as scripts/seed-skills.mjs
-- does. Never use INSERT OR REPLACE on skills: SQLite skips delete triggers on REPLACE, which
-- would leave stale search and count rows. If that ever happens, run scripts/library-rebuild.sql.

-- New descriptive fields, all filled from each file's front matter by scripts/seed-skills.mjs.
ALTER TABLE skills ADD COLUMN category TEXT NOT NULL DEFAULT '';      -- one area slug from src/lib/taxonomy.js ('' = not set yet)
ALTER TABLE skills ADD COLUMN tags TEXT NOT NULL DEFAULT '';          -- comma-separated tag slugs, for display and search
ALTER TABLE skills ADD COLUMN includes TEXT NOT NULL DEFAULT '';      -- "slug@version, ..." exactly as in the front matter
ALTER TABLE skills ADD COLUMN sections TEXT NOT NULL DEFAULT '';      -- the file's "## " headings, one per line ("What's inside")
ALTER TABLE skills ADD COLUMN changelog TEXT NOT NULL DEFAULT '';     -- the "## Version history" bullet lines, one per line
ALTER TABLE skills ADD COLUMN words INTEGER NOT NULL DEFAULT 0;       -- approximate word count of the file
ALTER TABLE skills ADD COLUMN published_at INTEGER NOT NULL DEFAULT 0; -- first published (updated_at changes with each new version)
UPDATE skills SET published_at = updated_at WHERE published_at = 0;

-- Library indexes: every list, filter and sort reads only the rows it shows (D1 bills rows read).
CREATE INDEX skills_lib_title   ON skills(published, title COLLATE NOCASE, slug);
CREATE INDEX skills_lib_new     ON skills(published, published_at DESC, title COLLATE NOCASE);
CREATE INDEX skills_lib_updated ON skills(published, updated_at DESC, title COLLATE NOCASE);
CREATE INDEX skills_lib_cat     ON skills(published, category, title COLLATE NOCASE, slug);
CREATE INDEX skills_lib_tier    ON skills(published, tier, title COLLATE NOCASE, slug);

-- Tags (filter: /skills?tag=...) and components of higher-tier skills ("What it combines", "Used in").
CREATE TABLE skill_tags (
  tag   TEXT NOT NULL,
  slug  TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  PRIMARY KEY (tag, slug)
) WITHOUT ROWID;
CREATE INDEX skill_tags_slug ON skill_tags(slug);
CREATE TABLE skill_includes (
  parent         TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  child          TEXT NOT NULL,
  child_version  TEXT NOT NULL,
  PRIMARY KEY (parent, position)
) WITHOUT ROWID;
CREATE INDEX skill_includes_child ON skill_includes(child);

-- Published-skill counts per (tier, area), kept exact by the triggers below. The library reads
-- these few rows for its counts instead of counting thousands of skills on every visit.
CREATE TABLE skill_facets (
  tier      TEXT NOT NULL,
  category  TEXT NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tier, category)
) WITHOUT ROWID;

-- Full-text search over the public catalogue fields only (never the skill files). rowid = skills.rowid.
CREATE VIRTUAL TABLE skills_fts USING fts5(title, summary, tags, category, tokenize = 'porter unicode61 remove_diacritics 2');

CREATE TRIGGER skills_lib_ai AFTER INSERT ON skills BEGIN
  UPDATE skills SET published_at = new.updated_at WHERE rowid = new.rowid AND new.published_at = 0;
  INSERT INTO skills_fts (rowid, title, summary, tags, category) VALUES (new.rowid, new.title, new.summary, replace(replace(new.tags, ',', ' '), '-', ' '), replace(new.category, '-', ' '));
  INSERT INTO skill_facets (tier, category, n) SELECT new.tier, new.category, 1 WHERE new.published = 1
    ON CONFLICT (tier, category) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER skills_lib_ad AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE rowid = old.rowid;
  UPDATE skill_facets SET n = n - 1 WHERE old.published = 1 AND tier = old.tier AND category = old.category;
END;
CREATE TRIGGER skills_lib_au AFTER UPDATE OF title, summary, tags, category, tier, published ON skills BEGIN
  DELETE FROM skills_fts WHERE rowid = old.rowid;
  INSERT INTO skills_fts (rowid, title, summary, tags, category) VALUES (new.rowid, new.title, new.summary, replace(replace(new.tags, ',', ' '), '-', ' '), replace(new.category, '-', ' '));
  UPDATE skill_facets SET n = n - 1 WHERE old.published = 1 AND tier = old.tier AND category = old.category;
  INSERT INTO skill_facets (tier, category, n) SELECT new.tier, new.category, 1 WHERE new.published = 1
    ON CONFLICT (tier, category) DO UPDATE SET n = n + 1;
END;

-- Fill search and counts for the skills already live (11 rows on Oct 20, 2026).
INSERT INTO skills_fts (rowid, title, summary, tags, category) SELECT rowid, title, summary, replace(replace(tags, ',', ' '), '-', ' '), replace(category, '-', ' ') FROM skills;
INSERT INTO skill_facets (tier, category, n) SELECT tier, category, COUNT(*) FROM skills WHERE published = 1 GROUP BY tier, category;
