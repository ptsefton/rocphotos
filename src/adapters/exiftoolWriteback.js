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
