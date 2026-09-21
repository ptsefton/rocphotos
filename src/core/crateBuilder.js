import { ROCrate } from 'ro-crate';
import { keywordsFromExif, ratingFromExif, regionsFromExif } from './exif.js';
import { personEntityId, petEntityId } from './db/store.js';

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
 * @returns {{path: string, name: string, dateCreated: string|null, description: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[], rating: number|null, people: string[], pets: string[], regions: Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>}}
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
  const regions = exifError ? [] : regionsFromExif(exif);
  const regionNames = new Set(regions.map((region) => region.name));
  // A region's name is also written into the keyword fields by the
  // tagging tool itself (confirmed against real files) — once it is
  // recorded as its own Person/Pet entity below, it is no longer also a
  // plain keyword.
  const keywords = (exifError ? [] : keywordsFromExif(exif)).filter((keyword) => !regionNames.has(keyword));
  const rating = exifError ? null : ratingFromExif(exif);
  const people = regions.filter((region) => region.type === 'Face').map((region) => region.name);
  const pets = regions.filter((region) => region.type === 'Pet').map((region) => region.name);

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
    // keywords, rating, and about are each explicitly cleared, not just
    // left unset, when the current pass finds none — a rescan can easily
    // drop a previously-recorded value to nothing (a region moving a
    // photo's only keyword into `about`, or a rating/tag being removed
    // upstream), and leaving the old value in place would silently
    // resurrect it.
    if (keywords.length > 0) {
      entity.keywords = keywords;
    } else if ('keywords' in entity) {
      delete entity.keywords;
    }
    if (rating !== null) {
      entity.rating = rating;
    } else if ('rating' in entity) {
      delete entity.rating;
    }
    if (regions.length > 0) {
      // Duplicated into every crate that references them ("the RO-Crate
      // way"): each crate's own ro-crate-metadata.json stays a complete,
      // standalone description of what it contains, rather than relying
      // on a Person/Pet node defined only in some other crate's file.
      const about = [];
      const regionRefs = [];
      regions.forEach((region, index) => {
        const subjectId = region.type === 'Face' ? personEntityId(region.name) : petEntityId(region.name);
        const subjectType = region.type === 'Face' ? 'Person' : 'Pet';
        crate.addEntity({ '@id': subjectId, '@type': subjectType, name: region.name }, { replace: true });
        about.push({ '@id': subjectId });

        // A stable, index-based id, same reasoning as the EXIF
        // PropertyValue nodes above: a rescan overwrites the same region
        // node rather than accumulating a fresh one every pass. name and
        // regionType are duplicated onto the region itself (rather than
        // requiring a caller to resolve `about` for them) since only one
        // level of a reference is resolved when this crate is served as
        // JSON (see entityCrate.js).
        const regionId = `${path}#region-${index}`;
        const regionEntity = { '@id': regionId, '@type': 'ImageRegion', name: region.name, regionType: region.type, about: { '@id': subjectId } };
        if (region.area) {
          regionEntity.xPosition = region.area.x;
          regionEntity.yPosition = region.area.y;
          regionEntity.width = region.area.w;
          regionEntity.height = region.area.h;
        }
        crate.addEntity(regionEntity, { replace: true });
        regionRefs.push({ '@id': regionId });
      });
      entity.about = about;
      entity.regions = regionRefs;
    } else {
      if ('about' in entity) delete entity.about;
      if ('regions' in entity) delete entity.regions;
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

  return { path, name: fileName, dateCreated, description, thumbnailPath, exifEntries, keywords, rating, people, pets, regions };
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
 * @returns {{path: string, name: string, dateCreated: string|null, description: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[], rating: number|null, people: string[], pets: string[], regions: Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>}|null}
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

  // Likewise, each element of entity.about is already the resolved
  // Person/Pet entity itself, so its own type tells apart which bucket
  // it belongs in without needing a second, parallel property.
  const people = [];
  const pets = [];
  for (const about of entity.about ?? []) {
    const type = unwrap(about['@type']);
    const name = unwrap(about.name);
    if (type === 'Person') people.push(name);
    else if (type === 'Pet') pets.push(name);
  }

  // Each element of entity.regions is likewise already the resolved
  // ImageRegion entity itself; name and regionType are read straight off
  // it rather than through its own `about` reference (see addImageEntity).
  const regions = (entity.regions ?? []).map((region) => ({
    name: unwrap(region.name),
    type: unwrap(region.regionType),
    area: region.xPosition !== undefined
      ? { x: unwrap(region.xPosition), y: unwrap(region.yPosition), w: unwrap(region.width), h: unwrap(region.height) }
      : null,
  }));

  return {
    path,
    name: unwrap(entity.name) ?? path.split('/').pop(),
    dateCreated: unwrap(entity.dateCreated) ?? null,
    description: unwrap(entity.description) ?? null,
    thumbnailPath: unwrap(entity.thumbnail)?.['@id'] ?? null,
    exifEntries,
    keywords: entity.keywords ?? [],
    rating: unwrap(entity.rating) ?? null,
    people,
    pets,
    regions,
  };
}

/**
 * Replaces an image's keywords outright — a manual edit, independent of
 * whatever addImageEntity would derive from EXIF. Since a rescan only
 * ever re-derives keywords for a file whose modification time has
 * actually changed (see recordedModifiedTime), a manual edit survives an
 * ordinary rescan of an otherwise-unchanged file; only --reprocess, which
 * forces re-extraction regardless, would overwrite it with whatever EXIF
 * says instead.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @param {string[]} keywords
 */
export function setImageKeywords(crate, path, keywords) {
  const entity = crate.getEntity(path);
  if (!entity) return;
  if (keywords.length > 0) {
    entity.keywords = keywords;
  } else if ('keywords' in entity) {
    delete entity.keywords;
  }
}

/**
 * Replaces an image's star rating outright — see setImageKeywords for the
 * same reasoning about surviving an ordinary rescan.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @param {number|null} rating
 */
export function setImageRating(crate, path, rating) {
  const entity = crate.getEntity(path);
  if (!entity) return;
  if (rating !== null) {
    entity.rating = rating;
  } else if ('rating' in entity) {
    delete entity.rating;
  }
}

/**
 * Removes an image entirely from a crate — used when the source file
 * itself has been moved to the trash (see core/trash.js) and so no
 * longer belongs in the crate's graph at all. Cleans up every node
 * exclusively owned by this one image (its EXIF PropertyValue nodes, its
 * ImageRegion nodes, and its thumbnail entity), but never a Person/Pet
 * entity it referenced via `about` — those are shared with, and may
 * still be depicted in, other images in this same crate.
 *
 * @param {ROCrate} crate
 * @param {string} path
 */
export function removeImageEntity(crate, path) {
  const entity = crate.getEntity(path);
  if (!entity) return;

  crate.deleteValues(crate.rootId, 'hasPart', { '@id': path });

  for (const ref of entity.exifData ?? []) {
    crate.deleteEntity(ref['@id']);
  }
  for (const ref of entity.regions ?? []) {
    crate.deleteEntity(ref['@id']);
  }
  const thumbnailId = unwrap(entity.thumbnail)?.['@id'];
  if (thumbnailId) {
    crate.deleteEntity(thumbnailId);
  }

  crate.deleteEntity(path);
}
