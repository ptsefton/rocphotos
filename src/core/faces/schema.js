// Schema for the faces companion index (_rocphotos/faces/faces-index.sqlite
// — see Spec.md's Face Recognition section). A separate SQLite file from
// the main rocphotos-index.sqlite, since it tracks a distinct concern
// (detection/matching bookkeeping) that most of the app never needs to
// touch, and is regenerable from the faces crate the same way the main
// index is regenerable from the photo crates.
export const FACES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scanned_images (
  image_id TEXT PRIMARY KEY,
  file_mtime INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

-- One row per confirmed reference example: a face embedding known to
-- belong to a person (person_id set), or a permanently-suppressed
-- "stranger" (person_id NULL — see faces/store.js). A confirmed person's
-- reference always links back to the real ImageRegion it came from
-- rather than storing a bare vector, so the example can be inspected
-- (cropped from its source photo on demand) and re-derived if the
-- embedding model ever changes; a stranger reference has no such region
-- (it is deliberately never written back to a photo file as a real
-- region), so source_region_id is null for those.
CREATE TABLE IF NOT EXISTS reference_faces (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  person_name TEXT,
  source_region_id TEXT,
  source_image_id TEXT NOT NULL,
  embedding TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reference_faces_person ON reference_faces(person_id);

-- One row per detected face awaiting (or past) review. box_x/box_y are
-- the fractional top-left corner (matching face-api.js's own box shape),
-- box_w/box_h fractional width/height — converted to MWG's center-point
-- convention only when a confirmed detection is written back to the
-- photo file (see faces/writeback.js).
CREATE TABLE IF NOT EXISTS detections (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  box_x REAL NOT NULL,
  box_y REAL NOT NULL,
  box_w REAL NOT NULL,
  box_h REAL NOT NULL,
  embedding TEXT NOT NULL,
  suggested_person_id TEXT,
  suggested_person_name TEXT,
  suggested_distance REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_person_id TEXT,
  resolved_person_name TEXT,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_image ON detections(image_id);
CREATE INDEX IF NOT EXISTS idx_detections_status ON detections(status);
`;
