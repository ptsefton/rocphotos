import { describe, it, expect, beforeEach } from 'vitest';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import {
  ensureFacesSchema,
  isImageAlreadyScanned,
  markImageScanned,
  addReferenceFace,
  listReferenceFaces,
  addDetection,
  getDetection,
  listDetections,
  updateDetectionStatus,
  updateDetectionSuggestion,
  repairMismatchedSourceRegionIds,
  hasReferenceForPersonOnImage,
  deduplicateReferenceFaces,
} from '../src/core/faces/store.js';

let db;

beforeEach(() => {
  db = openNodeSqlite(':memory:');
  ensureFacesSchema(db);
});

describe('scanned_images', () => {
  it('reports an image as not scanned until markImageScanned is called for its current mtime/model', () => {
    expect(isImageAlreadyScanned(db, 'a.jpg', 1000, 'face-api.js', '0.22.2')).toBe(false);
    markImageScanned(db, { imageId: 'a.jpg', fileMtime: 1000, modelName: 'face-api.js', modelVersion: '0.22.2' });
    expect(isImageAlreadyScanned(db, 'a.jpg', 1000, 'face-api.js', '0.22.2')).toBe(true);
  });

  it('treats a changed mtime as not scanned, so an edited file is re-scanned', () => {
    markImageScanned(db, { imageId: 'a.jpg', fileMtime: 1000, modelName: 'face-api.js', modelVersion: '0.22.2' });
    expect(isImageAlreadyScanned(db, 'a.jpg', 2000, 'face-api.js', '0.22.2')).toBe(false);
  });

  it('treats a different model version as not scanned, so a model upgrade re-scans', () => {
    markImageScanned(db, { imageId: 'a.jpg', fileMtime: 1000, modelName: 'face-api.js', modelVersion: '0.22.2' });
    expect(isImageAlreadyScanned(db, 'a.jpg', 1000, 'face-api.js', '0.23.0')).toBe(false);
  });
});

describe('reference_faces', () => {
  it('stores and lists reference faces for a given model/version only', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'a.jpg#region-0', sourceImageId: 'a.jpg', embedding: [0.1, 0.2],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });
    addReferenceFace(db, {
      id: 'ref-2', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: 'b.jpg', embedding: [0.9, 0.9],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });
    addReferenceFace(db, {
      id: 'ref-3', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'c.jpg#region-0', sourceImageId: 'c.jpg', embedding: [0.1, 0.2],
      modelName: 'face-api.js', modelVersion: '0.30.0',
    });

    const current = listReferenceFaces(db, 'face-api.js', '0.22.2');
    expect(current).toHaveLength(2);
    expect(current.find((r) => r.id === 'ref-1').embedding).toEqual([0.1, 0.2]);
    expect(current.find((r) => r.id === 'ref-2').personId).toBeNull();

    expect(listReferenceFaces(db, 'face-api.js', '0.30.0')).toHaveLength(1);
  });
});

describe('hasReferenceForPersonOnImage', () => {
  it('is true only for the exact (image, person, model, version) combination', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'a.jpg#region-0', sourceImageId: 'a.jpg', embedding: [0.1, 0.2],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });

    expect(hasReferenceForPersonOnImage(db, 'a.jpg', 'arcp://name,rocphoto/person/alice', 'face-api.js', '0.22.2')).toBe(true);
    // A different image, a different person, a different model/version,
    // and the row-with-no-region-index-in-common case (see this
    // function's own doc comment) all correctly say "no reference yet".
    expect(hasReferenceForPersonOnImage(db, 'b.jpg', 'arcp://name,rocphoto/person/alice', 'face-api.js', '0.22.2')).toBe(false);
    expect(hasReferenceForPersonOnImage(db, 'a.jpg', 'arcp://name,rocphoto/person/bob', 'face-api.js', '0.22.2')).toBe(false);
    expect(hasReferenceForPersonOnImage(db, 'a.jpg', 'arcp://name,rocphoto/person/alice', 'face-api.js', '0.30.0')).toBe(false);
  });

  it('is unaffected by what source_region_id happens to be, unlike the old region-id-based check it replaced', () => {
    // The exact bug this function exists to avoid: a crate-relative vs.
    // collection-relative mismatch (or any other inconsistency in how
    // source_region_id was built) used to make an already-backfilled
    // face look unbackfilled forever. This check never looks at
    // source_region_id at all, so it cannot repeat that.
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'some-completely-unrelated-string', sourceImageId: '2024/02/03/a.jpg', embedding: [0.1],
      modelName: 'm', modelVersion: '1',
    });
    expect(hasReferenceForPersonOnImage(db, '2024/02/03/a.jpg', 'arcp://name,rocphoto/person/alice', 'm', '1')).toBe(true);
  });
});

describe('deduplicateReferenceFaces', () => {
  it('keeps one row per (image, person, model, version) and removes the rest', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'a.jpg#region-0', sourceImageId: 'a.jpg', embedding: [0.1],
      modelName: 'm', modelVersion: '1',
    });
    // Simulates the duplicate this whole bug produced: the same person,
    // same image, same model, added again on a later run that failed to
    // recognise the first one as already backfilled.
    addReferenceFace(db, {
      id: 'ref-2', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'a.jpg#region-1', sourceImageId: 'a.jpg', embedding: [0.11],
      modelName: 'm', modelVersion: '1',
    });
    // A different image is a real, separate reference — not a duplicate.
    addReferenceFace(db, {
      id: 'ref-3', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice',
      sourceRegionId: 'b.jpg#region-0', sourceImageId: 'b.jpg', embedding: [0.12],
      modelName: 'm', modelVersion: '1',
    });

    const removed = deduplicateReferenceFaces(db);
    expect(removed).toEqual(1);
    expect(listReferenceFaces(db, 'm', '1')).toHaveLength(2);
  });

  it('never removes a stranger reference (no person_id), even several from the same image', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: 'a.jpg', embedding: [0.9],
      modelName: 'm', modelVersion: '1',
    });
    addReferenceFace(db, {
      id: 'ref-2', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: 'a.jpg', embedding: [0.91],
      modelName: 'm', modelVersion: '1',
    });
    expect(deduplicateReferenceFaces(db)).toEqual(0);
    expect(listReferenceFaces(db, 'm', '1')).toHaveLength(2);
  });
});

describe('detections', () => {
  it('round-trips a detection, parsing its embedding back into an array', () => {
    addDetection(db, {
      id: 'det-1', imageId: 'a.jpg', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, embedding: [1, 2, 3],
      suggestedPersonId: null, suggestedPersonName: null, suggestedDistance: null,
      status: 'pending', modelName: 'face-api.js', modelVersion: '0.22.2',
    });
    const detection = getDetection(db, 'det-1');
    expect(detection.embedding).toEqual([1, 2, 3]);
    expect(detection.box_x).toEqual(0.1);
    expect(detection.status).toEqual('pending');
  });

  it('filters by status and by a given set of image ids', () => {
    addDetection(db, { id: 'det-1', imageId: 'a.jpg', box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1], status: 'pending', modelName: 'm', modelVersion: '1' });
    addDetection(db, { id: 'det-2', imageId: 'b.jpg', box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1], status: 'ignored', modelName: 'm', modelVersion: '1' });
    addDetection(db, { id: 'det-3', imageId: 'c.jpg', box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1], status: 'pending', modelName: 'm', modelVersion: '1' });

    expect(listDetections(db, { status: 'pending' }).map((d) => d.id).sort()).toEqual(['det-1', 'det-3']);
    expect(listDetections(db, { imageIds: ['a.jpg', 'c.jpg'] }).map((d) => d.id).sort()).toEqual(['det-1', 'det-3']);
    expect(listDetections(db, { status: 'pending', imageIds: ['a.jpg'] }).map((d) => d.id)).toEqual(['det-1']);
    expect(listDetections(db, { imageIds: [] })).toEqual([]);
  });

  it('updates status and resolved person on confirm', () => {
    addDetection(db, { id: 'det-1', imageId: 'a.jpg', box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1], status: 'pending', modelName: 'm', modelVersion: '1' });
    updateDetectionStatus(db, 'det-1', { status: 'confirmed', resolvedPersonId: 'arcp://name,rocphoto/person/bob', resolvedPersonName: 'Bob' });
    const detection = getDetection(db, 'det-1');
    expect(detection.status).toEqual('confirmed');
    expect(detection.resolved_person_name).toEqual('Bob');
  });

  it('starts with an empty rejected-Person list, and updateDetectionSuggestion replaces it along with the suggestion', () => {
    addDetection(db, {
      id: 'det-1', imageId: 'a.jpg', box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1],
      suggestedPersonId: 'arcp://name,rocphoto/person/alice', suggestedPersonName: 'Alice', suggestedDistance: 0.2,
      status: 'pending', modelName: 'm', modelVersion: '1',
    });
    expect(getDetection(db, 'det-1').rejectedPersonIds).toEqual([]);

    updateDetectionSuggestion(db, 'det-1', {
      suggestedPersonId: 'arcp://name,rocphoto/person/bob', suggestedPersonName: 'Bob', suggestedDistance: 0.4,
      status: 'pending', rejectedPersonIds: ['arcp://name,rocphoto/person/alice'],
    });
    const detection = getDetection(db, 'det-1');
    expect(detection.suggested_person_name).toEqual('Bob');
    expect(detection.rejectedPersonIds).toEqual(['arcp://name,rocphoto/person/alice']);
  });
});

describe('ensureFacesSchema migration', () => {
  it('adds rejected_person_ids to a detections table created before it existed', () => {
    const oldDb = openNodeSqlite(':memory:');
    // A faithful stand-in for a faces index built before rejected_person_ids
    // existed — CREATE TABLE IF NOT EXISTS alone would never add a column
    // to this already-existing table.
    oldDb.exec(`
      CREATE TABLE detections (
        id TEXT PRIMARY KEY, image_id TEXT NOT NULL, box_x REAL NOT NULL, box_y REAL NOT NULL,
        box_w REAL NOT NULL, box_h REAL NOT NULL, embedding TEXT NOT NULL,
        suggested_person_id TEXT, suggested_person_name TEXT, suggested_distance REAL,
        status TEXT NOT NULL DEFAULT 'pending', resolved_person_id TEXT, resolved_person_name TEXT,
        model_name TEXT NOT NULL, model_version TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    oldDb.run(
      `INSERT INTO detections (id, image_id, box_x, box_y, box_w, box_h, embedding, status, model_name, model_version, created_at)
       VALUES ('det-1', 'a.jpg', 0, 0, 1, 1, '[1]', 'pending', 'm', '1', '2026-01-01T00:00:00.000Z')`,
    );

    ensureFacesSchema(oldDb);

    const columns = oldDb.all('PRAGMA table_info(detections)').map((row) => row.name);
    expect(columns).toContain('rejected_person_ids');
    // A pre-existing row gets the column's default, not null (which
    // would violate rejected_person_ids' own NOT NULL constraint if this
    // migration's default did not apply retroactively).
    expect(getDetection(oldDb, 'det-1').rejectedPersonIds).toEqual([]);
  });

  it('is safe to call repeatedly without erroring once the column already exists', () => {
    expect(() => {
      ensureFacesSchema(db);
      ensureFacesSchema(db);
    }).not.toThrow();
  });
});

describe('repairMismatchedSourceRegionIds', () => {
  it('rebuilds a crate-relative source_region_id (the pre-fix /faces/confirm bug) from its own source_image_id', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/bob', personName: 'Bob',
      sourceRegionId: 'photo.jpg#region-2', sourceImageId: '2024/02/03/photo.jpg', embedding: [1],
      modelName: 'm', modelVersion: '1',
    });
    const fixed = repairMismatchedSourceRegionIds(db);
    expect(fixed).toEqual(1);
    expect(listReferenceFaces(db, 'm', '1')[0].sourceRegionId).toEqual('2024/02/03/photo.jpg#region-2');
  });

  it('leaves an already-correct row (root-crate images, or anything backfilled since the fix) untouched', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: 'arcp://name,rocphoto/person/bob', personName: 'Bob',
      sourceRegionId: 'photo.jpg#region-0', sourceImageId: 'photo.jpg', embedding: [1],
      modelName: 'm', modelVersion: '1',
    });
    expect(repairMismatchedSourceRegionIds(db)).toEqual(0);
  });

  it('leaves a stranger reference (no source_region_id at all) untouched', () => {
    addReferenceFace(db, {
      id: 'ref-1', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: '2024/02/03/photo.jpg', embedding: [1],
      modelName: 'm', modelVersion: '1',
    });
    expect(repairMismatchedSourceRegionIds(db)).toEqual(0);
  });
});
