import { addImageEntity } from './crateBuilder.js';
import { extractExif } from './exif.js';
import { thumbnailPathFor } from './thumbnails.js';
import { joinPath } from './pathUtils.js';
import {
  ENTITY_TYPE_IMAGE,
  ENTITY_TYPE_PERSON,
  ENTITY_TYPE_PET,
  imageEntityId,
  crateEntityId,
  personEntityId,
  petEntityId,
  facetValuesFromRecord,
  upsertEntity,
  setEntityFacetValues,
} from './db/store.js';

/**
 * Re-extracts EXIF for one already-scanned image and updates both its
 * crate entity and its index rows to match, the same way a normal scan
 * does for a changed file — used after writing new metadata directly to
 * the source file (see faces/writeback and the exiftool adapter), so the
 * change is reflected immediately without waiting for the next full
 * `rocphotos scan`. Does not regenerate the thumbnail: a metadata-only
 * file write does not change the image's pixels.
 *
 * The caller is responsible for saving `subCrate` back to disk afterwards
 * (via serializeCrate/fsAdapter.writeFile) — this only mutates the
 * in-memory crate object and the index, the same division of
 * responsibility bin/rocphotos.js's own scan loop already has.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} db
 * @param {string} crateDirPath
 * @param {import('ro-crate').ROCrate} subCrate
 * @param {string} imagePath - relative to crateDirPath
 * @returns {Promise<ReturnType<typeof addImageEntity>>}
 */
export async function rescanImageMetadata(fsAdapter, db, crateDirPath, subCrate, imagePath) {
  const fullImagePath = joinPath(crateDirPath, imagePath);
  const bytes = await fsAdapter.readFile(fullImagePath);
  const { exif, error: exifError } = await extractExif(bytes);
  const { modifiedTime } = await fsAdapter.stat(fullImagePath);
  const record = addImageEntity(subCrate, {
    path: imagePath,
    exif,
    exifError,
    thumbnailPath: thumbnailPathFor(imagePath),
    thumbnailError: null,
    sourceModifiedAt: modifiedTime,
  });

  const entityId = imageEntityId(crateDirPath, imagePath);
  const roCrateId = crateEntityId(crateDirPath);
  upsertEntity(db, {
    id: entityId,
    roCrateId,
    entityType: ENTITY_TYPE_IMAGE,
    name: record.name,
    title: record.title,
    description: record.description,
    processingError: record.processingError,
    memberOf: roCrateId,
    dateCreated: record.dateCreated,
  });
  const { camera, lens } = facetValuesFromRecord(record);
  setEntityFacetValues(db, entityId, 'camera', camera ? [camera] : []);
  setEntityFacetValues(db, entityId, 'lens', lens ? [lens] : []);
  setEntityFacetValues(db, entityId, 'keyword', record.keywords);
  setEntityFacetValues(db, entityId, 'rating', record.rating !== null ? [String(record.rating)] : []);
  setEntityFacetValues(db, entityId, 'people', record.people);
  setEntityFacetValues(db, entityId, 'pets', record.pets);
  for (const name of record.people) {
    upsertEntity(db, { id: personEntityId(name), roCrateId, entityType: ENTITY_TYPE_PERSON, name });
  }
  for (const name of record.pets) {
    upsertEntity(db, { id: petEntityId(name), roCrateId, entityType: ENTITY_TYPE_PET, name });
  }

  return record;
}
