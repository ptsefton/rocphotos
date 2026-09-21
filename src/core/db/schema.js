export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ro_crates (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  ro_crate_id TEXT NOT NULL REFERENCES ro_crates(id),
  entity_type TEXT NOT NULL,
  name TEXT,
  description TEXT,
  member_of TEXT,
  metadata_license_id TEXT,
  content_license_id TEXT,
  access_metadata INTEGER NOT NULL DEFAULT 1,
  access_content INTEGER NOT NULL DEFAULT 1,
  date_created TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  filename TEXT NOT NULL,
  media_type TEXT,
  size INTEGER,
  relative_path TEXT NOT NULL,
  access_content INTEGER NOT NULL DEFAULT 1
);

-- One row per (entity, facet name, value) triple: a generic index for
-- every facet (camera, lens, keyword, and whatever gets added later —
-- subject, people, ...), rather than a dedicated column or table per
-- facet. This handles a facet with several values per entity (keyword)
-- and one with at most one (camera, lens) the same way, and adding a new
-- facet is just new rows, never a schema change. date_created stays a
-- plain column on entities rather than living here too, since it is also
-- used to sort search results, not only to facet by year (year is
-- derived from it at query time — see facetCounts in db/store.js —
-- rather than stored separately).
CREATE TABLE IF NOT EXISTS entity_facets (
  entity_id TEXT NOT NULL REFERENCES entities(id),
  facet_name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (entity_id, facet_name, value)
);

CREATE INDEX IF NOT EXISTS idx_entities_ro_crate_id ON entities(ro_crate_id);
CREATE INDEX IF NOT EXISTS idx_entities_member_of ON entities(member_of);
CREATE INDEX IF NOT EXISTS idx_entities_date_created ON entities(date_created);
CREATE INDEX IF NOT EXISTS idx_files_entity_id ON files(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_facets_name_value ON entity_facets(facet_name, value);
CREATE INDEX IF NOT EXISTS idx_entity_facets_entity_id ON entity_facets(entity_id);
`;
