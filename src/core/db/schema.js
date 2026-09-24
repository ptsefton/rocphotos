export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ro_crates (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- description is the entity's own real caption (IPTC Caption-Abstract /
-- XMP dc:description), if it has one; processing_error is unrelated — an
-- EXIF/thumbnail extraction failure, if one occurred (see crateBuilder.js;
-- the two used to share this one column, meaning a caption and an error
-- could never coexist). title (IPTC ObjectName / XMP dc:title) always has
-- a value, falling back to the filename when the file has no title of
-- its own — unlike description, which is simply absent when there is
-- nothing to show.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  ro_crate_id TEXT NOT NULL REFERENCES ro_crates(id),
  entity_type TEXT NOT NULL,
  name TEXT,
  title TEXT,
  description TEXT,
  processing_error TEXT,
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

-- An album itself is just another entities row (entity_type
-- ENTITY_TYPE_ALBUM — see db/store.js), the same way a Person/Pet is,
-- reusing its existing name/description columns rather than a parallel
-- table with its own copies of them; date_created doubles as "last used"
-- for an album (bumped on creation and on every add — see
-- addAlbumMembers), so "recently used albums" is a plain ORDER BY on a
-- column that already exists, no new one needed. This table only records
-- membership, in order: position is assigned once, when an image is
-- added, and never renumbered, so an album's order survives images being
-- added in more than one batch over time.
CREATE TABLE IF NOT EXISTS album_members (
  album_id TEXT NOT NULL REFERENCES entities(id),
  image_id TEXT NOT NULL REFERENCES entities(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (album_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_album_members_album_id ON album_members(album_id, position);
`;
