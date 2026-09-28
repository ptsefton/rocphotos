import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Reads a file's existing MWG region list via the system `exiftool`
 * binary (never hand-parsed: MWG's structured XMP is exactly what
 * exiftool exists to get right). Returns null if the file has no
 * RegionInfo of its own yet.
 *
 * @param {string} absolutePath
 * @returns {Promise<{AppliedToDimensions?: object, RegionList?: object|object[]}|null>}
 */
async function readRegionInfo(absolutePath) {
  const { stdout } = await execFileAsync('exiftool', ['-j', '-struct', '-G1', '-XMP-mwg-rs:RegionInfo', absolutePath]);
  const info = JSON.parse(stdout)[0]?.['XMP-mwg-rs:RegionInfo'];
  return info && typeof info === 'object' ? info : null;
}

// Only needed to populate AppliedToDimensions on a file with no
// RegionInfo of its own yet (Area itself is always fractional regardless
// — see writeFaceRegion). A second exiftool call, made only in that one
// case, rather than requiring every caller to already know the image's
// pixel size.
async function readImageDimensions(absolutePath) {
  const { stdout } = await execFileAsync('exiftool', ['-j', '-ImageWidth', '-ImageHeight', absolutePath]);
  const { ImageWidth, ImageHeight } = JSON.parse(stdout)[0] ?? {};
  return { width: ImageWidth, height: ImageHeight };
}

/**
 * Appends one MWG Face region to a photo file's existing XMP region list,
 * preserving every region already there (including fields this app does
 * not itself understand, such as a vendor-specific Rotation — see
 * Spec.md's Face Recognition section) — confirmed safe against a real
 * digiKam-tagged file: only XMP-mwg-rs:RegionList changes, nothing else
 * in the file is touched. Writes via a temporary `-json=` file rather
 * than a command-line struct argument, since exiftool's own structured
 * command-line syntax (distinct from JSON) is easy to get subtly wrong;
 * round-tripping through the exact shape exiftool itself reads and
 * writes avoids that.
 *
 * `-overwrite_original` is used deliberately: this app manages its own
 * `_rocphotos/trash` rather than relying on exiftool's `_original`
 * backup files, which would otherwise accumulate unnoticed throughout
 * the collection.
 *
 * @param {string} absolutePath
 * @param {object} options
 * @param {string} options.name - the person's display name
 * @param {{x: number, y: number, w: number, h: number}} options.area - fractional top-left box (face-api.js's own shape)
 */
export async function writeFaceRegion(absolutePath, { name, area }) {
  const existing = await readRegionInfo(absolutePath);
  const regionList = existing?.RegionList ? (Array.isArray(existing.RegionList) ? existing.RegionList : [existing.RegionList]) : [];

  regionList.push({
    Type: 'Face',
    Name: name,
    // MWG records a region's center point and full width/height, not a
    // top-left corner (see Spec.md) — converted here from face-api.js's
    // own top-left box shape.
    Area: { X: area.x + area.w / 2, Y: area.y + area.h / 2, W: area.w, H: area.h },
  });

  let appliedToDimensions = existing?.AppliedToDimensions;
  if (!appliedToDimensions) {
    const { width, height } = await readImageDimensions(absolutePath);
    appliedToDimensions = { W: width, H: height, Unit: 'pixel' };
  }

  const regionInfo = { AppliedToDimensions: appliedToDimensions, RegionList: regionList };

  const tmpFile = path.join(os.tmpdir(), `rocphotos-mwg-${randomUUID()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify([{ SourceFile: absolutePath, 'XMP-mwg-rs:RegionInfo': regionInfo }]));
  try {
    await execFileAsync('exiftool', ['-overwrite_original', `-json=${tmpFile}`, absolutePath]);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// Writes one exiftool `-json=` payload to a file, the same way
// writeFaceRegion does and for the same reason (round-tripping through
// the exact shape exiftool itself reads and writes, rather than its
// fiddlier structured command-line syntax).
async function writeTagsViaJson(absolutePath, tags) {
  const tmpFile = path.join(os.tmpdir(), `rocphotos-tags-${randomUUID()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify([{ SourceFile: absolutePath, ...tags }]));
  try {
    await execFileAsync('exiftool', ['-overwrite_original', `-json=${tmpFile}`, absolutePath]);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Writes a whole image record's metadata — every named region, plus
 * keywords, title, caption, and rating — into a photo file, replacing
 * whatever it already had for those tags. Used on an exported *copy*
 * (see export.js's writeExportMetadata), never on a collection
 * original: this is the one place where wholesale replacement rather
 * than writeFaceRegion's careful append is the right thing, since the
 * crate's own record is by then the complete truth about the image
 * (`readImageRecord` merges what came from the file's own EXIF with
 * everything this app has added since), and the file being written is a
 * copy that was made moments ago.
 *
 * Each value is written to both its XMP and its IPTC home, and keywords
 * additionally to Lightroom's hierarchical extension, because a reader
 * (including this app's own extractExif — see exif.js's KEYWORD_FIELDS
 * and friends) may prefer any one of them: writing only some would
 * leave a stale value in a field a later scan reads in preference to
 * the one just written.
 *
 * @param {string} absolutePath
 * @param {{regions?: Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>, keywords?: string[], title?: string|null, description?: string|null, rating?: number|null, imageWidth?: number|null, imageHeight?: number|null}} record - as returned by crateBuilder.js's readImageRecord (whose `area` is already MWG's centre-based convention), plus the image's pixel dimensions if the crate happens to know them
 */
export async function writeImageMetadata(absolutePath, {
  regions = [], keywords = [], title = null, description = null, rating = null, imageWidth = null, imageHeight = null,
}) {
  const tags = {};

  const placed = regions.filter((region) => region.name && region.area);
  if (placed.length > 0) {
    let dimensions = imageWidth && imageHeight ? { W: imageWidth, H: imageHeight, Unit: 'pixel' } : null;
    if (!dimensions) {
      const { width, height } = await readImageDimensions(absolutePath);
      dimensions = { W: width, H: height, Unit: 'pixel' };
    }
    tags['XMP-mwg-rs:RegionInfo'] = {
      AppliedToDimensions: dimensions,
      RegionList: placed.map((region) => ({
        Type: region.type,
        Name: region.name,
        Area: { X: region.area.x, Y: region.area.y, W: region.area.w, H: region.area.h },
      })),
    };
  }

  // An empty list clears the tag rather than being skipped: a copy
  // inherits the original's own keywords, so leaving them alone would
  // resurrect ones since removed in this app.
  tags['XMP-dc:Subject'] = keywords;
  tags['XMP-lr:HierarchicalSubject'] = keywords;
  tags['IPTC:Keywords'] = keywords;

  tags['XMP-dc:Title'] = title ?? '';
  tags['IPTC:ObjectName'] = title ?? '';
  tags['XMP-dc:Description'] = description ?? '';
  tags['IPTC:Caption-Abstract'] = description ?? '';
  tags['XMP:Rating'] = rating ?? '';

  await writeTagsViaJson(absolutePath, tags);
}

/**
 * Whether the `exiftool` binary this app shells out to for writing face
 * regions back into photo files is actually available — checked once at
 * server startup so a missing binary produces one clear error up front,
 * not a confusing failure the first time someone tries to confirm a
 * face.
 *
 * @returns {Promise<boolean>}
 */
export async function isExiftoolAvailable() {
  try {
    await execFileAsync('exiftool', ['-ver']);
    return true;
  } catch {
    return false;
  }
}
