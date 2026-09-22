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
});
