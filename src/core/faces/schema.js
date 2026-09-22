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

-- Which images have had every one of their already-tagged Face regions
-- backfilled (see faces/store.js's isBackfillFullyChecked) — an image is
-- only ever marked here once every named region on it already has a
-- reference; one that still has a region without one (an embedding that
-- failed to compute, say) is left unmarked, so it is looked at again
-- (and only its still-missing region retried, via
-- hasReferenceForPersonOnImage) on a later pass rather than silently
-- never being retried. Lets /faces/existing-regions skip reading and
-- parsing an unchanged image's crate at all on a later "Recognize
-- Faces" run, instead of re-examining every tagged image in the whole
-- collection on every single click.
CREATE TABLE IF NOT EXISTS backfill_checked_images (
  image_id TEXT PRIMARY KEY,
  file_mtime INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- One row per already-tagged region that the browser genuinely tried
-- (both a whole-image detection pass and a zoomed, low-confidence crop
-- fallback — see webview/app.js's computeEmbeddingForKnownRegion) and
-- still could not compute an embedding for — confirmed, by inspecting
-- real examples, to be faces face-api.js just cannot see: full side
-- profiles, faces behind sunglasses, severe motion blur, extreme
-- backlighting. Retrying the same photo with the same model on a later
-- pass cannot produce a different result, so rather than leaving it to
-- be silently retried (and its image re-examined) forever, it is marked
-- here and treated the same as a real reference for the purposes of
-- isBackfillFullyChecked — but distinctly from one, so it is never
-- confused with an actual match. Keyed on (image, person), like
-- reference_faces, not on a region index. A model_version bump makes
-- last row obsolete the same way it does for reference_faces, so a
-- future, better model naturally gets its own attempt.
CREATE TABLE IF NOT EXISTS backfill_undetectable_regions (
  image_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (image_id, person_id, model_name, model_version)
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
-- photo file (see faces/writeback.js). rejected_person_ids is a JSON
-- array: every Person a reviewer has explicitly said this detection is
-- NOT (see /faces/reject-suggestion) — excluded from matching on every
-- later re-match attempt for this same detection, so rejecting a wrong
-- suggestion tries the next-best one instead of just re-suggesting the
-- same wrong Person again.
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
  rejected_person_ids TEXT NOT NULL DEFAULT '[]',
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_image ON detections(image_id);
CREATE INDEX IF NOT EXISTS idx_detections_status ON detections(status);
`;
