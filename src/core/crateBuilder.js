import { ROCrate } from 'ro-crate';
import { keywordsFromExif } from './exif.js';

export const CRATE_FILE_NAME = 'ro-crate-metadata.json';

// The EXIF fields surfaced as PropertyValue entities in the crate, and
// shown as an EXIF table in the generated HTML preview (see
// src/core/htmlPreview.js). Kept as a single list so the two never drift
// apart.
const EXIF_TABLE_FIELDS = ['Make', 'Model', 'ImageWidth', 'ImageHeight', 'Orientation', 'LensMake', 'LensModel'];

/**
 * Loads a crate from an existing ro-crate-metadata.json text, or creates a
 * new, empty crate if none was given.
 *
 * @param {string|null} existingJsonText
 * @returns {ROCrate}
 */
export function loadOrCreateCrate(existingJsonText) {
  const data = existingJsonText ? JSON.parse(existingJsonText) : undefined;
  // link: true resolves an {'@id': ...} reference into the full entity it
  // points to when read back (e.g. entity.thumbnail, entity.exifData
  // elements) — purely a read-side convenience, it does not change what
  // gets serialized to disk (still plain JSON-LD references).
  return new ROCrate(data, { array: true, link: true });
}

export function serializeCrate(crate) {
  return JSON.stringify(crate, null, 2);
}

export function setDatasetName(crate, name) {
  if (!crate.rootDataset.name) {
    crate.rootDataset.name = name;
  }
}

/**
 * Ensures the root crate references a sub-collection crate directory as a
 * hasPart Dataset. Safe to call repeatedly across rescans.
 *
 * @param {ROCrate} rootCrate
 * @param {string} subCratePath
 */
export function addSubCrateReference(rootCrate, subCratePath) {
  const id = `${subCratePath}/`;
  if (!rootCrate.getEntity(id)) {
    rootCrate.addEntity({ '@id': id, '@type': 'Dataset', name: subCratePath });
  }
  rootCrate.addValues(rootCrate.rootId, 'hasPart', { '@id': id });
}

/**
 * Extracts an ISO 8601 date string from an EXIF DateTimeOriginal field, or
 * null if none is available. Shared by crate construction and by callers
 * that need the same date for HTML preview navigation, so the two never
 * disagree.
 *
 * @param {object|null} exif
 * @returns {string|null}
 */
export function dateCreatedFromExif(exif) {
  if (!exif || !exif.DateTimeOriginal) return null;
  return exif.DateTimeOriginal instanceof Date
    ? exif.DateTimeOriginal.toISOString()
    : String(exif.DateTimeOriginal);
}

// Under `{ array: true }`, ro-crate-js wraps a previously scalar-assigned
// property in a one-element array when read back (an array-valued
// property, such as hasPart or exifData, is returned as-is). This unwraps
// the scalar case, for reading a value back out of an existing entity.
function unwrap(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Adds or updates an ImageObject entity (and its linked thumbnail entity,
 * if one is supplied) within a sub-collection crate, and lists it in the
 * crate's hasPart. Safe to call repeatedly across rescans.
 *
 * Recording errors: an EXIF extraction error and a thumbnail generation
 * error are two distinct things that can each independently go wrong for
 * the same file; both are folded into the single `description` property
 * (joined together if both occurred) rather than tracked in separate
 * fields or a separate log file, so a file's full error state lives in
 * one place in the crate itself — readable by readImageRecord below,
 * shown in the generated HTML preview, and usable by a caller to decide
 * whether a file is worth attempting again.
 *
 * @param {ROCrate} crate
 * @param {object} options
 * @param {string} options.path - image path, relative to the crate directory
 * @param {object|null} [options.exif] - fields returned by extractExif
 * @param {string|null} [options.exifError] - error message from extractExif
 * @param {string|null} [options.thumbnailPath] - thumbnail path, relative to the crate directory, if one was generated
 * @param {string|null} [options.thumbnailError] - error message from thumbnail generation, if it failed
 * @param {number|null} [options.sourceModifiedAt] - the source file's modification time (epoch ms) as of this processing pass, used to detect whether it needs reprocessing on a later scan
 * @returns {{path: string, name: string, dateCreated: string|null, description: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[]}}
 */
export function addImageEntity(crate, {
  path,
  exif = null,
  exifError = null,
  thumbnailPath = null,
  thumbnailError = null,
  sourceModifiedAt = null,
}) {
  const fileName = path.split('/').pop();
  const entity = crate.getEntity(path) ?? { '@id': path, '@type': 'ImageObject' };
  entity.name = fileName;
  const dateCreated = dateCreatedFromExif(exif);
  const exifEntries = [];
  const keywords = exifError ? [] : keywordsFromExif(exif);

  if (!exifError && exif) {
    if (dateCreated) {
      entity.dateCreated = dateCreated;
    }
    const exifData = [];
    for (const key of EXIF_TABLE_FIELDS) {
      if (exif[key] !== undefined) {
        const value = String(exif[key]);
        // A stable, explicit id (rather than an auto-generated one), added
        // as its own entity with replace:true, so that a rescan overwrites
        // the same node instead of accumulating a fresh orphaned entity
        // every pass (addEntity's `recurse` option does not itself
        // propagate `replace` to nested entities).
        const id = `${path}#exif-${key}`;
        crate.addEntity({ '@id': id, '@type': 'PropertyValue', name: key, value }, { replace: true });
        exifData.push({ '@id': id });
        exifEntries.push({ name: key, value });
      }
    }
    if (exifData.length > 0) {
      entity.exifData = exifData;
    }
    if (keywords.length > 0) {
      entity.keywords = keywords;
    }
  }

  const description = [exifError, thumbnailError].filter(Boolean).join(' | ') || null;
  if (description) {
    entity.description = description;
  }

  if (thumbnailPath) {
    if (!crate.getEntity(thumbnailPath)) {
      crate.addEntity({ '@id': thumbnailPath, '@type': 'ImageObject', name: `Thumbnail of ${fileName}` });
    }
    entity.thumbnail = { '@id': thumbnailPath };
  }

  if (sourceModifiedAt !== null) {
    entity.dateModified = new Date(sourceModifiedAt).toISOString();
  }

  crate.addEntity(entity, { replace: true });
  crate.addValues(crate.rootId, 'hasPart', { '@id': path });

  return { path, name: fileName, dateCreated, description, thumbnailPath, exifEntries, keywords };
}

/**
 * The source file modification time (epoch ms) recorded the last time
 * this image was processed (see `sourceModifiedAt` on addImageEntity), or
 * null if the image has no entity yet, or was never given one.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @returns {number|null}
 */
export function recordedModifiedTime(crate, path) {
  const entity = crate.getEntity(path);
  const dateModified = entity ? unwrap(entity.dateModified) : undefined;
  return dateModified ? new Date(dateModified).getTime() : null;
}

/**
 * Reconstructs the same record shape addImageEntity returns, from an
 * already-existing entity — used to reuse a previous scan's result for an
 * image whose source file has not changed since (see
 * recordedModifiedTime), without re-reading or re-parsing it.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @returns {{path: string, name: string, dateCreated: string|null, description: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[]}|null}
 */
export function readImageRecord(crate, path) {
  const entity = crate.getEntity(path);
  if (!entity) return null;

  // With link: true, each element of entity.exifData is already the
  // resolved PropertyValue entity itself, not a bare {'@id': ...} stub.
  const exifEntries = (entity.exifData ?? []).map((propertyValue) => ({
    name: unwrap(propertyValue.name),
    value: unwrap(propertyValue.value),
  }));

  return {
    path,
    name: unwrap(entity.name) ?? path.split('/').pop(),
    dateCreated: unwrap(entity.dateCreated) ?? null,
    description: unwrap(entity.description) ?? null,
    thumbnailPath: unwrap(entity.thumbnail)?.['@id'] ?? null,
    exifEntries,
    keywords: entity.keywords ?? [],
  };
}
