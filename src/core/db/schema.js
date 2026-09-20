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
  access_content INTEGER NOT NULL DEFAULT 1
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

CREATE INDEX IF NOT EXISTS idx_entities_ro_crate_id ON entities(ro_crate_id);
CREATE INDEX IF NOT EXISTS idx_entities_member_of ON entities(member_of);
CREATE INDEX IF NOT EXISTS idx_files_entity_id ON files(entity_id);
`;
