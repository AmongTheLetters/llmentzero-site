// Skill library taxonomy. The 12 areas were approved by Chris on Oct 20, 2026 (LIBRARY-UX-PLAN.md §5).
// One "area" per skill, set with `category: <slug>` in the file's front matter. Areas are broad on purpose
// (anything an AI can learn to do), so they stay useful at 10 or 10,000 skills. Add areas here; never
// rename or remove a slug that skills use, because it is part of the public URL /skills/category/<slug>.
export const CATEGORIES = [
  { slug: "writing", name: "Writing and editing", blurb: "Drafting, rewriting and polishing text." },
  { slug: "communication", name: "Meetings and communication", blurb: "Notes, follow-ups, updates and messages." },
  { slug: "planning", name: "Planning and organizing", blurb: "Tasks, checklists, priorities and open items." },
  { slug: "research", name: "Research and sources", blurb: "Finding, checking and citing information." },
  { slug: "data", name: "Data and analysis", blurb: "Cleaning, summarizing and explaining data." },
  { slug: "teaching", name: "Teaching and learning", blurb: "Explaining, tutoring and practice." },
  { slug: "creative", name: "Creative work", blurb: "Ideas, stories, design and media." },
  { slug: "marketing", name: "Marketing and sales", blurb: "Campaigns, content, audiences and offers." },
  { slug: "support", name: "Customer support", blurb: "Answering, routing and following up with customers." },
  { slug: "technical", name: "Software and technical", blurb: "Code, systems and technical writing." },
  { slug: "operations", name: "Operations and admin", blurb: "Processes, policies and day-to-day running." },
  { slug: "everyday", name: "Everyday life", blurb: "Personal, home and life admin." },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c]));

/** The six tiers, smallest first, with the same one-line meaning as /tiers (tools/build_pages.py). */
export const TIERS = ["Basic", "Compound", "General", "Specialist", "Expert", "Complete"];
export const TIER_INFO = {
  Basic: "One simple skill",
  Compound: "A few basics combined",
  General: "A full role bundle",
  Specialist: "A focused add-on",
  Expert: "Deep, advanced material",
  Complete: "A whole function",
};

/** Tag slugs: lower-case words joined by hyphens, at most 40 characters. */
export const TAG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
