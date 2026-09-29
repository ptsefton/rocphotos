import { ROCrate } from 'ro-crate';
import { keywordsFromExif, ratingFromExif, regionsFromExif, titleFromExif, descriptionFromExif } from './exif.js';
import { personEntityId, petEntityId, nameSlug } from './db/store.js';

export const CRATE_FILE_NAME = 'ro-crate-metadata.json';

// The EXIF fields surfaced as PropertyValue entities in the crate, and
// shown as an EXIF table in the generated HTML preview (see
// src/core/htmlPreview.js). Kept as a single list so the two never drift
// apart.
const EXIF_TABLE_FIELDS = ['Make', 'Model', 'ImageWidth', 'ImageHeight', 'Orientation', 'LensMake', 'LensModel'];

// The vocabulary this application coins, because schema.org has no
// equivalent — the face/pet region shape, the star rating, the
// face-recognition reference data. Bound as real term definitions
// rather than a prefix so the crates themselves are unchanged: they go
// on writing `regionType`, not `rocphotos:regionType`, and the binding
// is what gives that bare term an IRI instead of leaving it to the
// `@vocab` fallback, where it would silently read as a schema.org term
// that schema.org does not define.
//
// Only terms that resolve to nothing otherwise are listed. `width` and
// `height`, which a region also uses, are deliberately absent: they are
// real schema.org properties already, and redefining a standard term to
// mean something of ours would be a worse trade than the slight
// stretch of using it.
//
// See the rocphotos MASP profile, whose rules name these same IRIs.
const ROCPHOTOS_TERMS_NAMESPACE = 'https://w3id.org/ldac/rocphotos/terms#';
const ROCPHOTOS_TERMS = [
  'Pet', 'ImageRegion', 'FaceEmbedding',
  'regions', 'regionType', 'xPosition', 'yPosition', 'writtenToFile',
  'rating', 'processingError',
  'embedding', 'embeddingModel', 'embeddingModelVersion', 'sourceImage', 'sourceRegion',
];

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
  const crate = new ROCrate(data, { array: true, link: true });
  // Bound on every crate, not only the ones currently holding a standoff
  // region (see addStandoffFaceRegion): RO-Crate's own context defines
  // `prov` but not `oa`, so without this the `oa:` terms are not compact
  // IRIs at all — they expand to a literal `oa:hasBody`, silently
  // unconnected to the Web Annotation vocabulary they are meant to be.
  // addTermDefinition writes into the existing context object and returns
  // early if the term already resolves, so a crate read and written back
  // repeatedly gains it exactly once. An older crate picks it up the next
  // time anything rewrites it.
  crate.addTermDefinition('oa', 'http://www.w3.org/ns/oa#');
  // Same idempotent, write-into-the-existing-context call as `oa` above,
  // so an older crate picks these up the next time anything rewrites it
  // and a crate read and written back repeatedly gains each exactly once.
  for (const term of ROCPHOTOS_TERMS) {
    crate.addTermDefinition(term, `${ROCPHOTOS_TERMS_NAMESPACE}${term}`);
  }
  return crate;
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
 * The member image ids currently recorded on an album's own entity, in
 * order — read via its `hasPart` (see setAlbumEntity below), which is
 * the one and only place membership is stored; there is no separate
 * index table for it. Returns `[]` for a brand new album (no entity
 * yet) rather than requiring every caller to guard for that.
 *
 * Each `hasPart` entry is not the real image itself but a small proxy
 * entity (`<albumId>#item-<n>`, a `prov:specializationOf` the real image
 * — see setAlbumEntity), so this follows that one extra hop. The
 * indirection exists so an image's appearance *in this album* can later
 * have its own name/description (a caption for how this photo is used
 * here, distinct from its own real title) without touching the real
 * image's own entity, which is shared by every other place that
 * depicts it.
 *
 * @param {ROCrate} rootCrate
 * @param {string} id
 * @returns {string[]}
 */
export function albumMemberIds(rootCrate, id) {
  const entity = rootCrate.getEntity(id);
  return (entity?.hasPart ?? [])
    .map((ref) => rootCrate.getEntity(ref['@id']))
    .filter(Boolean)
    .map((proxy) => unwrap(proxy['prov:specializationOf'])?.['@id'])
    .filter(Boolean);
}

/**
 * Creates or updates an album's own entity in the root crate (Section
 * 2.2/Section 3's Albums) — unlike addSubCrateReference above, always
 * replaces the album entity itself outright (name, description, and the
 * member list can all change after creation), the same way a confirmed
 * face's Person/Pet node is replaced on every write in addImageEntity.
 * `hasPart` doubles as the album's own member list and its display order
 * (JSON array order is preserved), so no separate ordering property is
 * needed. Safe to call repeatedly.
 *
 * Each member is recorded as a proxy entity, `<id>#item-<index>`
 * (`prov:specializationOf` the real image — see albumMemberIds above),
 * not a direct reference to the real image — created once, the first
 * time an image reaches that position, and never replaced again by this
 * function afterwards. This is deliberate: a proxy is where an
 * album-specific name/description for that image would eventually live
 * (not yet settable through any route/UI — this only lays the data model
 * down), and replacing it unconditionally on every call here (e.g. every
 * time more photos are added, or the album's own name is edited) would
 * silently wipe that out.
 *
 * @param {ROCrate} rootCrate
 * @param {{id: string, name: string, description: string|null, memberIds: string[]}} album
 */
export function setAlbumEntity(rootCrate, { id, name, description, memberIds }) {
  const entity = { '@id': id, '@type': 'ImageGallery', name, hasPart: memberIds.map((_, index) => ({ '@id': `${id}#item-${index}` })) };
  if (description) entity.description = description;
  rootCrate.addEntity(entity, { replace: true });
  rootCrate.addValues(rootCrate.rootId, 'hasPart', { '@id': id });

  memberIds.forEach((imageId, index) => {
    const proxyId = `${id}#item-${index}`;
    if (!rootCrate.getEntity(proxyId)) {
      rootCrate.addEntity({ '@id': proxyId, '@type': 'ImageObject', 'prov:specializationOf': { '@id': imageId } });
    }
  });
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

// A title always has some value: the image's own IPTC/XMP title if it
// has one, its filename otherwise — never left blank, unlike keywords or
// a caption, which have no sensible fallback and are just absent when
// there is nothing to show.
function titleOrFallback(fileName, title) {
  const trimmed = title?.trim();
  return trimmed || fileName;
}

// The compact region encoding a standoff face/pet region's `oa:hasTarget`
// uses (see addStandoffFaceRegion and Spec.md's Face Recognition
// section) — a W3C Media Fragments URI, `#xywh=percent:x,y,w,h`,
// top-left corner + size as a 0-100 percentage of the full image. Kept
// as a plain marker search (not an anchored regex over the whole target
// id) since the image path preceding the fragment can itself contain
// arbitrary characters.
const XYWH_PERCENT_MARKER = '#xywh=percent:';

function toXywhPercentFragment(path, box) {
  const pct = (fraction) => Math.round(fraction * 100 * 10000) / 10000;
  return `${path}${XYWH_PERCENT_MARKER}${pct(box.x)},${pct(box.y)},${pct(box.w)},${pct(box.h)}`;
}

// Returns a top-left, 0-1 fractional box (face-api.js's own convention),
// or null if `targetId` has no recognised fragment.
function parseXywhPercentFragment(targetId) {
  if (!targetId) return null;
  const markerIndex = targetId.lastIndexOf(XYWH_PERCENT_MARKER);
  if (markerIndex === -1) return null;
  const parts = targetId.slice(markerIndex + XYWH_PERCENT_MARKER.length).split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  const [x, y, w, h] = parts;
  return { x: x / 100, y: y / 100, w: w / 100, h: h / 100 };
}

/**
 * The id of a Person/Pet *as depicted in one crate* — an instance of the
 * shared identity, local to this crate (a bare fragment, resolved
 * against the crate itself), not the collection-wide `arcp://` id.
 *
 * @param {string} name
 * @param {'Person'|'Pet'} subjectType
 * @returns {string}
 */
export function subjectInstanceId(name, subjectType) {
  return `#${subjectType === 'Pet' ? 'pet' : 'person'}-${nameSlug(name)}`;
}

/**
 * Records a Person/Pet in a crate as two nodes, and returns the id of
 * the one everything in the crate should point at.
 *
 * The `arcp://` node is the identity itself, shared collection-wide and
 * duplicated into every crate depicting them (per RO-Crate convention,
 * so each crate reads standalone); the root crate's copy is the one that
 * carries their full description (see syncRootCrateSubjects). The
 * instance node is *them, here*: one per crate, `prov:specializationOf`
 * the shared identity, and what an image's `about` and a region point
 * at.
 *
 * The indirection is what lets the same person be recorded under a
 * different name in a different part of the collection — a married name
 * in the 2015 crates and a maiden name in the 2005 ones — while both
 * still resolve to one identity. Every reference inside a crate goes
 * through its instance, so there is one place per crate to say how they
 * were known then.
 *
 * @param {ROCrate} crate
 * @param {{name: string, subjectId: string, subjectType: 'Person'|'Pet'}} subject
 * @returns {string} the instance id
 */
function addSubjectInstance(crate, { name, subjectId, subjectType }) {
  const instanceId = subjectInstanceId(name, subjectType);
  crate.addEntity({ '@id': subjectId, '@type': subjectType, name }, { replace: true });
  crate.addEntity({
    '@id': instanceId, '@type': subjectType, name, 'prov:specializationOf': { '@id': subjectId },
  }, { replace: true });
  return instanceId;
}

/**
 * Adds a "standoff" face/pet region for a confirmed detection — recorded
 * entirely in the crate, independent of whether it has also been (or
 * ever will be) written into the photo file's own EXIF (Spec.md's Face
 * Recognition section: writing to the original file is an opt-in,
 * off-by-default, separate step — confirming a face must not depend on
 * that opt-in to have any visible effect at all). Modelled on the W3C
 * Web Annotation Vocabulary (`oa:`, `http://www.w3.org/ns/oa#`) plus a
 * `prov:specializationOf` proxy for the body — the same indirection
 * Albums already use for a member image, and for the same reason: *this*
 * appearance of a Person/Pet, in this one region, could later carry its
 * own region-specific properties without touching the real, shared
 * Person/Pet entity every other photo depicting them also references.
 *
 * Safe to call more than once for the same image (a photo can have more
 * than one confirmed face): each call adds its own new region rather
 * than replacing an earlier one. Ids are `#region-standoff-<n>`, in
 * their own namespace distinct from `#region-<n>`'s EXIF-derived
 * numbering, which is fully renumbered from scratch on every rescan
 * (see addImageEntity below) — a standoff region must never share that
 * namespace, or a later rescan could hand its number to an unrelated
 * EXIF-derived region.
 *
 * @param {ROCrate} crate
 * @param {string} path - image path, relative to the crate directory
 * @param {{name: string, subjectId: string, subjectType: 'Person'|'Pet', box: {x: number, y: number, w: number, h: number}}} options - box is face-api.js's own fractional (0-1) top-left shape
 * @returns {{regionId: string}|null} null if the image has no entity yet
 */
export function addStandoffFaceRegion(crate, path, { name, subjectId, subjectType, box }) {
  const entity = crate.getEntity(path);
  if (!entity) return null;

  const usedStandoffIndexes = (entity.regions ?? [])
    .map((ref) => /#region-standoff-(\d+)$/.exec(ref['@id'])?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  const nextIndex = usedStandoffIndexes.length > 0 ? Math.max(...usedStandoffIndexes) + 1 : 0;

  const regionId = `${path}#region-standoff-${nextIndex}`;
  const bodyId = `${regionId}-body`;

  // The body proxy specializes this crate's instance of them, which in
  // turn specializes the shared identity (see addSubjectInstance) — so
  // every path from a region to a Person/Pet runs through the one
  // instance node, rather than some going straight to the arcp id.
  const instanceId = addSubjectInstance(crate, { name, subjectId, subjectType });
  crate.addEntity({ '@id': bodyId, '@type': subjectType, 'prov:specializationOf': { '@id': instanceId } }, { replace: true });
  crate.addEntity({
    '@id': regionId,
    '@type': ['ImageRegion', 'oa:Annotation'],
    name,
    regionType: subjectType === 'Person' ? 'Face' : 'Pet',
    'oa:motivatedBy': { '@id': 'oa:identifying' },
    'oa:hasTarget': { '@id': toXywhPercentFragment(path, box) },
    'oa:hasBody': { '@id': bodyId },
    writtenToFile: false,
  }, { replace: true });

  crate.addValues(path, 'regions', { '@id': regionId });
  crate.addValues(path, 'about', { '@id': instanceId });

  return { regionId };
}

/**
 * Adds or updates an ImageObject entity (and its linked thumbnail entity,
 * if one is supplied) within a sub-collection crate, and lists it in the
 * crate's hasPart. Safe to call repeatedly across rescans.
 *
 * Recording errors: an EXIF extraction error and a thumbnail generation
 * error are two distinct things that can each independently go wrong for
 * the same file; both are folded into the single `processingError`
 * property (joined together if both occurred) rather than tracked in
 * separate fields or a separate log file, so a file's full error state
 * lives in one place in the crate itself — readable by readImageRecord
 * below, shown in the generated HTML preview, and usable by a caller to
 * decide whether a file is worth attempting again. This is distinct from
 * `description`, the image's own real IPTC/XMP caption (if any) — the
 * two used to share one property, which meant a processing error and a
 * real caption could never coexist; they are now independent.
 *
 * @param {ROCrate} crate
 * @param {object} options
 * @param {string} options.path - image path, relative to the crate directory
 * @param {object|null} [options.exif] - fields returned by extractExif
 * @param {string|null} [options.exifError] - error message from extractExif
 * @param {string|null} [options.thumbnailPath] - thumbnail path, relative to the crate directory, if one was generated
 * @param {string|null} [options.thumbnailError] - error message from thumbnail generation, if it failed
 * @param {number|null} [options.sourceModifiedAt] - the source file's modification time (epoch ms) as of this processing pass, used to detect whether it needs reprocessing on a later scan
 * @returns {{path: string, name: string, title: string, dateCreated: string|null, description: string|null, processingError: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[], rating: number|null, people: string[], pets: string[], regions: Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>}}
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
  let people = regions.filter((region) => region.type === 'Face').map((region) => region.name);
  let pets = regions.filter((region) => region.type === 'Pet').map((region) => region.name);
  const title = titleOrFallback(fileName, exifError ? null : titleFromExif(exif));
  const description = exifError ? null : descriptionFromExif(exif);

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
    // Preserves any existing "standoff" regions (confirmed by this app
    // but not, or not yet, written into the file's own EXIF — see
    // addStandoffFaceRegion) across this rescan: unlike an EXIF-derived
    // region, which is fully rebuilt from scratch every pass below, a
    // standoff region has no EXIF of its own to rebuild from, so it
    // would otherwise be silently deleted the next time this image is
    // rescanned. Dropped only once the same name shows up among the
    // freshly-read EXIF regions instead — write-back has since happened
    // (or another tool independently tagged them) — its own now-
    // redundant region and body-proxy nodes are deleted outright, not
    // left dangling in the graph.
    const freshNames = new Set(regions.map((region) => region.name));
    const preservedRegionRefs = [];
    const preservedAboutRefs = [];
    for (const ref of entity.regions ?? []) {
      const existingRegion = crate.getEntity(ref['@id']);
      if (!existingRegion || unwrap(existingRegion.writtenToFile) !== false) continue;
      const name = unwrap(existingRegion.name);
      const bodyId = unwrap(existingRegion['oa:hasBody'])?.['@id'];
      if (freshNames.has(name)) {
        if (bodyId) crate.deleteEntity(bodyId);
        crate.deleteEntity(ref['@id']);
        continue;
      }
      preservedRegionRefs.push(ref);
      const instanceId = unwrap(crate.getEntity(bodyId)?.['prov:specializationOf'])?.['@id'];
      if (instanceId) preservedAboutRefs.push({ '@id': instanceId });
      const type = unwrap(existingRegion.regionType);
      if (type === 'Face') people = [...people, name];
      else if (type === 'Pet') pets = [...pets, name];
    }

    const about = [];
    const regionRefs = [];
    if (regions.length > 0) {
      // Duplicated into every crate that references them ("the RO-Crate
      // way"): each crate's own ro-crate-metadata.json stays a complete,
      // standalone description of what it contains, rather than relying
      // on a Person/Pet node defined only in some other crate's file.
      regions.forEach((region, index) => {
        const subjectId = region.type === 'Face' ? personEntityId(region.name) : petEntityId(region.name);
        const subjectType = region.type === 'Face' ? 'Person' : 'Pet';
        const instanceId = addSubjectInstance(crate, { name: region.name, subjectId, subjectType });
        about.push({ '@id': instanceId });

        // A stable, index-based id, same reasoning as the EXIF
        // PropertyValue nodes above: a rescan overwrites the same region
        // node rather than accumulating a fresh one every pass. name and
        // regionType are duplicated onto the region itself (rather than
        // requiring a caller to resolve `about` for them) since only one
        // level of a reference is resolved when this crate is served as
        // JSON (see entityCrate.js).
        const regionId = `${path}#region-${index}`;
        const regionEntity = { '@id': regionId, '@type': 'ImageRegion', name: region.name, regionType: region.type, about: { '@id': instanceId } };
        if (region.area) {
          regionEntity.xPosition = region.area.x;
          regionEntity.yPosition = region.area.y;
          regionEntity.width = region.area.w;
          regionEntity.height = region.area.h;
        }
        crate.addEntity(regionEntity, { replace: true });
        regionRefs.push({ '@id': regionId });
      });
    }
    if (regions.length > 0 || preservedRegionRefs.length > 0) {
      entity.about = [...about, ...preservedAboutRefs];
      entity.regions = [...regionRefs, ...preservedRegionRefs];
    } else {
      if ('about' in entity) delete entity.about;
      if ('regions' in entity) delete entity.regions;
    }
  }

  // Outside the exif-success block above: a title always has a value
  // (see titleOrFallback) regardless of whether EXIF extraction
  // succeeded, so it is always set, never cleared. A caption, like
  // keywords or a rating, is only ever present when the file actually
  // has one, so has nothing to fall back to when EXIF failed.
  entity.title = title;
  if (description) {
    entity.description = description;
  } else if ('description' in entity) {
    delete entity.description;
  }

  const processingError = [exifError, thumbnailError].filter(Boolean).join(' | ') || null;
  if (processingError) {
    entity.processingError = processingError;
  } else if ('processingError' in entity) {
    // A file that failed once and now processes cleanly must not keep
    // showing its old error forever — the same class of stale-property
    // bug already fixed for keywords/rating above.
    delete entity.processingError;
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

  return { path, name: fileName, title, dateCreated, description, processingError, thumbnailPath, exifEntries, keywords, rating, people, pets, regions };
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
 * @returns {{path: string, name: string, title: string, dateCreated: string|null, description: string|null, processingError: string|null, thumbnailPath: string|null, exifEntries: Array<{name: string, value: string}>, keywords: string[], rating: number|null, people: string[], pets: string[], regions: Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>}|null}
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
  // Two possible shapes: an EXIF-derived region's own xPosition/etc.
  // (MWG's centre-based convention), or a standoff region's `oa:hasTarget`
  // fragment (see addStandoffFaceRegion — face-api.js's own top-left
  // convention, converted to the same centre-based shape here so every
  // caller of readImageRecord sees one consistent `area` regardless of
  // which kind of region it came from).
  const regions = (entity.regions ?? []).map((region) => {
    const name = unwrap(region.name);
    const type = unwrap(region.regionType);
    if (region.xPosition !== undefined) {
      return { name, type, area: { x: unwrap(region.xPosition), y: unwrap(region.yPosition), w: unwrap(region.width), h: unwrap(region.height) } };
    }
    const targetId = unwrap(region['oa:hasTarget'])?.['@id'];
    const box = parseXywhPercentFragment(targetId);
    const area = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2, w: box.w, h: box.h } : null;
    return { name, type, area };
  });

  return {
    path,
    name: unwrap(entity.name) ?? path.split('/').pop(),
    title: unwrap(entity.title) ?? titleOrFallback(path.split('/').pop(), null),
    dateCreated: unwrap(entity.dateCreated) ?? null,
    description: unwrap(entity.description) ?? null,
    processingError: unwrap(entity.processingError) ?? null,
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
 * Replaces an image's title outright — see setImageKeywords for the same
 * reasoning about surviving an ordinary rescan. Falls back to the
 * image's own filename (see titleOrFallback) if given an empty title,
 * the same as a freshly-scanned image with no IPTC/XMP title of its own,
 * rather than leaving it blank.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @param {string|null} title
 */
export function setImageTitle(crate, path, title) {
  const entity = crate.getEntity(path);
  if (!entity) return;
  entity.title = titleOrFallback(path.split('/').pop(), title);
}

/**
 * Replaces an image's free-text caption outright — see setImageKeywords
 * for the same reasoning about surviving an ordinary rescan. Unlike a
 * title, a caption has no fallback: given empty, it is cleared entirely.
 *
 * @param {ROCrate} crate
 * @param {string} path
 * @param {string|null} description
 */
export function setImageDescription(crate, path, description) {
  const entity = crate.getEntity(path);
  if (!entity) return;
  const trimmed = description?.trim();
  if (trimmed) {
    entity.description = trimmed;
  } else if ('description' in entity) {
    delete entity.description;
  }
}

/**
 * Moves one image from one Person/Pet identity to another — the
 * mechanics of merging two into one, or renaming one (see Spec.md's
 * People section).
 *
 * Every reference within a crate goes through that crate's *instance* of
 * the identity (see addSubjectInstance), so this swaps the source
 * instance for the target one wherever it appears on this image: its own
 * `about`, each of its regions' `about` (EXIF shape) and body-proxy
 * `prov:specializationOf` (standoff shape), plus the region's own
 * duplicated `name`. The target's instance and shared-identity nodes are
 * created here if this crate did not already know them.
 *
 * Leaves the source's own nodes in place — the caller removes them once,
 * after every image across every crate referencing them has been moved
 * (see people/handler.js), since a partially-merged crate must not lose
 * a node a not-yet-processed image still points at.
 *
 * A no-op, returning false, if this image never referenced the source at
 * all (e.g. it was tagged with a different one of several names being
 * merged in the same operation) or has no entity yet.
 *
 * @param {ROCrate} crate
 * @param {string} imagePath - image path, relative to the crate directory
 * @param {{sourceId: string, sourceName: string, targetId: string, targetName: string, subjectType: 'Person'|'Pet'}} options
 * @returns {boolean} whether anything on this image was actually changed
 */
export function renamePersonInCrate(crate, imagePath, { sourceId, sourceName, targetId, targetName, subjectType }) {
  if (sourceId === targetId) return false;
  const entity = crate.getEntity(imagePath);
  if (!entity) return false;

  // Everything inside a crate points at its instance of a Person/Pet,
  // not at the shared identity (see addSubjectInstance), so a rename is
  // a swap of one instance for another — which also brings the new
  // name, since an instance carries it.
  const targetInstanceId = subjectInstanceId(targetName, subjectType);
  // Either shape counts as "the source": a crate written before
  // instances existed points straight at the arcp id, and a scan only
  // rewrites an image whose file actually changed, so the two can sit
  // side by side in one crate indefinitely. Matching both is what stops
  // a merge silently skipping the un-migrated ones; whichever it finds,
  // it writes the instance, which migrates that reference on the way
  // past.
  const sourceIds = new Set([subjectInstanceId(sourceName, subjectType), sourceId]);
  let changed = false;

  if ((entity.about ?? []).some((ref) => sourceIds.has(ref['@id']))) {
    const ids = new Set(entity.about.map((ref) => ref['@id']).filter((id) => !sourceIds.has(id)));
    ids.add(targetInstanceId);
    entity.about = [...ids].map((id) => ({ '@id': id }));
    changed = true;
  }

  for (const ref of entity.regions ?? []) {
    const region = crate.getEntity(ref['@id']);
    if (!region) continue;

    if (sourceIds.has(unwrap(region.about)?.['@id'])) {
      region.about = { '@id': targetInstanceId };
      changed = true;
    }
    const bodyId = unwrap(region['oa:hasBody'])?.['@id'];
    const body = bodyId ? crate.getEntity(bodyId) : null;
    if (body && sourceIds.has(unwrap(body['prov:specializationOf'])?.['@id'])) {
      body['prov:specializationOf'] = { '@id': targetInstanceId };
      changed = true;
    }
    if (unwrap(region.name) === sourceName) {
      region.name = targetName;
      changed = true;
    }
  }

  if (changed) {
    addSubjectInstance(crate, { name: targetName, subjectId: targetId, subjectType });
  }
  return changed;
}

/**
 * Brings the root crate's own set of Person/Pet entities in line with
 * `subjects` — the collection-wide identities, listed on the root
 * dataset's `mentions` so they are reachable rather than floating
 * unreferenced in the graph.
 *
 * This is where a person is described in full: the sub-collection crates
 * carry a minimal copy of each identity for standalone readability (see
 * addSubjectInstance), but the root crate's copy is the one meant to
 * grow relationships, dates and the rest (Section 1's "coming soon").
 * Anything already recorded on an entity here is therefore preserved —
 * only `name` is kept in step — and an identity no longer depicted
 * anywhere is dropped, so a merged-away name does not linger.
 *
 * @param {ROCrate} rootCrate
 * @param {Array<{name: string, subjectType: 'Person'|'Pet'}>} subjects
 */
export function syncRootCrateSubjects(rootCrate, subjects) {
  const wanted = new Map(subjects.map((subject) => [
    subject.subjectType === 'Pet' ? petEntityId(subject.name) : personEntityId(subject.name),
    subject,
  ]));

  for (const ref of rootCrate.rootDataset.mentions ?? []) {
    const id = ref['@id'];
    if (wanted.has(id)) continue;
    rootCrate.deleteValues(rootCrate.rootId, 'mentions', { '@id': id });
    rootCrate.deleteEntity(id);
  }

  for (const [id, { name, subjectType }] of wanted) {
    const existing = rootCrate.getEntity(id);
    // Merged, not replaced: whatever else has been recorded about them
    // here is the point of this crate holding them at all.
    if (existing) existing.name = name;
    else rootCrate.addEntity({ '@id': id, '@type': subjectType, name });
    rootCrate.addValues(rootCrate.rootId, 'mentions', { '@id': id });
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
    const region = crate.getEntity(ref['@id']);
    // A standoff region's body is its own small proxy entity (see
    // addStandoffFaceRegion), exclusively owned by this one region the
    // same way its EXIF PropertyValue nodes are — never the shared
    // Person/Pet entity itself, which prov:specializationOf points to
    // and which this deliberately leaves alone.
    const bodyId = unwrap(region?.['oa:hasBody'])?.['@id'];
    if (bodyId) crate.deleteEntity(bodyId);
    crate.deleteEntity(ref['@id']);
  }
  const thumbnailId = unwrap(entity.thumbnail)?.['@id'];
  if (thumbnailId) {
    crate.deleteEntity(thumbnailId);
  }

  crate.deleteEntity(path);
}
