-- Rebuilds the library's search index and counts from the skills table (migration 0006).
-- Safe to run at any time; reads every skill once. Only needed if a skill row was ever written
-- with INSERT OR REPLACE (which skips delete triggers), or to double-check after a manual edit.
--   npx wrangler d1 execute llmentzero --local --file scripts/library-rebuild.sql
DELETE FROM skills_fts;
INSERT INTO skills_fts (rowid, title, summary, tags, category) SELECT rowid, title, summary, replace(replace(tags, ',', ' '), '-', ' '), replace(category, '-', ' ') FROM skills;
DELETE FROM skill_facets;
INSERT INTO skill_facets (tier, category, n) SELECT tier, category, COUNT(*) FROM skills WHERE published = 1 GROUP BY tier, category;
