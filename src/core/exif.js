import exifr from 'exifr';

const { parse } = exifr;

const EXIF_FIELDS = [
  'Make', 'Model', 'DateTimeOriginal', 'ImageWidth', 'ImageHeight', 'Orientation',
  'LensMake', 'LensModel', 'Rating',
];

// Keyword-bearing fields, checked in this order of preference. All three
// are commonly written together by keywording tools (Lightroom, digiKam,
// Photo Mechanic, ...): `Keywords` is the legacy IPTC field (a flat
// list); `subject` is its XMP (dc:subject) equivalent, also flat;
// `hierarchicalSubject` is Lightroom's XMP extension, encoding a keyword
// hierarchy as `Parent|Child` per entry. hierarchicalSubject is tried
// first since it is the most information-preserving of the three, though
// see keywordsFromExif for why that barely matters once flattened.
const KEYWORD_FIELDS = ['hierarchicalSubject', 'subject', 'Keywords'];

// The Metadata Working Group (MWG) region field, carrying named face/pet
// tags (and their bounding boxes, not currently extracted) as written by
// tools such as Lightroom, digiKam, and Photo Mechanic.
const REGION_FIELD = 'Regions';

// IPTC ObjectName / XMP dc:title — a short title, distinct from a longer
// free-text caption (see DESCRIPTION_FIELDS). exifr's IPTC dictionary
// keys this 'ObjectName'; its XMP equivalent comes through as 'title'.
const TITLE_FIELDS = ['ObjectName', 'title'];

// IPTC Caption-Abstract (keyed 'Caption' in exifr's own IPTC dictionary,
// not the literal IPTC field name) / XMP dc:description. Confirmed
// against real files that some cameras (Olympus, at least) write a
// boilerplate value here ("OLYMPUS DIGITAL CAMERA") on every photo
// rather than a real caption — extracted the same as any other value;
// telling that apart from an intentional caption is left to the person
// reviewing/editing it.
const DESCRIPTION_FIELDS = ['Caption', 'description'];

// exifr does not decode XML character references (numeric, like
// "&#39;", or named, like "&apos;") inside nested XMP struct fields —
// confirmed against a real file that a region Name containing an
// apostrophe round-trips as the literal text "Alana Mahon&#39;s
// Daughter" rather than "Alana Mahon's Daughter", even though the raw
// XMP on disk is valid, standard-escaped XML that any XML parser should
// decode on its own. Applied to every free-text value read out of such a
// struct (region names, keywords, title/description), since this is a
// parsing gap in the library, not something specific to one field.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(value) {
  if (typeof value !== 'string' || !value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/**
 * Extracts a small set of EXIF/IPTC/XMP fields from image bytes. A
 * missing or empty EXIF segment (common for formats such as PNG) is not
 * an error. Only a thrown parsing failure (malformed EXIF data) is
 * reported as an error, per the application's requirement to still add
 * the image to the crate and record the problem in its description.
 *
 * Note: passing exifr a plain array of wanted tag names (as this used to
 * do) only restricts what it reads from the EXIF/TIFF segment — it does
 * not, by itself, enable IPTC or XMP parsing at all, so fields such as
 * Keywords or hierarchicalSubject were never actually being read. The
 * `{ iptc: true, xmp: true }` object form is required to enable those
 * segments; the specific fields this application cares about (see
 * EXIF_FIELDS and KEYWORD_FIELDS) are then picked out of the full result
 * here, in application code, rather than via exifr's own `pick` option,
 * which was found not to reliably restrict output across segments.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{exif: object|null, error: string|null}>}
 */
export async function extractExif(bytes) {
  try {
    const tags = await parse(bytes, { iptc: true, xmp: true });
    if (!tags) {
      return { exif: null, error: null };
    }

    const picked = {};
    for (const key of [...EXIF_FIELDS, ...KEYWORD_FIELDS, REGION_FIELD, ...TITLE_FIELDS, ...DESCRIPTION_FIELDS]) {
      if (tags[key] !== undefined) {
        picked[key] = tags[key];
      }
    }
    return { exif: picked, error: null };
  } catch (err) {
    return { exif: null, error: `EXIF extraction failed: ${err.message}` };
  }
}

/**
 * Flattens whichever keyword field is present (see KEYWORD_FIELDS) into a
 * de-duplicated, flat list of individual keyword terms. A hierarchical
 * entry such as "Bird|Nankeen Kestrel" (the real-world separator
 * confirmed against files tagged in Lightroom; other tools may use a
 * different one, such as '/' or '>', and this would need adjusting to
 * match) contributes both "Bird" and "Nankeen Kestrel" as independent
 * terms, so that selecting the broader term ("Bird") as a facet still
 * finds photos tagged only with the more specific one.
 *
 * @param {object|null} exif
 * @returns {string[]}
 */
export function keywordsFromExif(exif) {
  if (!exif) return [];

  const source = KEYWORD_FIELDS.map((key) => exif[key]).find((value) => value !== undefined);
  if (!source) return [];

  const entries = Array.isArray(source) ? source : [source];
  const flat = new Set();
  for (const entry of entries) {
    for (const level of decodeXmlEntities(String(entry)).split('|')) {
      const trimmed = level.trim();
      if (trimmed) flat.add(trimmed);
    }
  }
  return [...flat];
}

/**
 * Reads the XMP star rating (0-5), if present. Many tools (including
 * Lightroom, confirmed against real files) write `Rating: 0` on every
 * photo they touch, not only ones a person actually starred, so a rating
 * of 0 is indistinguishable from "never rated" and is treated as absent
 * here — only a rating of 1 or higher is considered a real rating.
 *
 * @param {object|null} exif
 * @returns {number|null}
 */
export function ratingFromExif(exif) {
  if (!exif) return null;
  const rating = Number(exif.Rating);
  return Number.isFinite(rating) && rating > 0 ? rating : null;
}

/**
 * Reads named MWG regions (face and pet tags) from EXIF, ignoring
 * regions of any other type and any region left unnamed (a detected but
 * unidentified face). Confirmed against real files that a keywording
 * tool commonly writes the very same name into the keyword fields (see
 * KEYWORD_FIELDS) as it writes into a region — callers should exclude a
 * region's name from a photo's keywords once it is recorded here, rather
 * than keeping both.
 *
 * @param {object|null} exif
 * @returns {Array<{name: string, type: 'Face'|'Pet', area: {x: number, y: number, w: number, h: number}|null}>}
 */
export function regionsFromExif(exif) {
  const regionList = exif?.[REGION_FIELD]?.RegionList;
  if (!regionList) return [];

  const entries = Array.isArray(regionList) ? regionList : [regionList];
  return entries
    .filter((region) => region?.Name && (region.Type === 'Face' || region.Type === 'Pet'))
    .map((region) => ({
      name: decodeXmlEntities(String(region.Name)).trim(),
      type: region.Type,
      // Fractional (0-1) position/size of the region within the image, as
      // MWG records it — convenient for an overlay drawn with CSS
      // percentages, without needing the image's pixel dimensions.
      area: region.Area
        ? { x: region.Area.x, y: region.Area.y, w: region.Area.w, h: region.Area.h }
        : null,
    }))
    .filter((region) => region.name.length > 0);
}

// An XMP LangAlt value (title/description) is a plain string when there
// is exactly one language, but comes through as {lang, value} (a single
// alternative) or an array of those (several languages) otherwise —
// confirmed against a real file's XMP description. Always resolves to
// the one plain string this application actually uses, preferring
// 'x-default' when several languages are present.
function flattenLangAlt(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = decodeXmlEntities(value).trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const preferred = value.find((entry) => entry?.lang === 'x-default') ?? value[0];
    return flattenLangAlt(preferred);
  }
  if (typeof value === 'object' && 'value' in value) {
    return flattenLangAlt(value.value);
  }
  return null;
}

/**
 * The image's own short title (IPTC ObjectName / XMP dc:title), if any —
 * distinct from a longer free-text caption (see descriptionFromExif).
 *
 * @param {object|null} exif
 * @returns {string|null}
 */
export function titleFromExif(exif) {
  if (!exif) return null;
  const source = TITLE_FIELDS.map((key) => exif[key]).find((value) => value !== undefined);
  return flattenLangAlt(source);
}

/**
 * The image's own free-text caption (IPTC Caption-Abstract / XMP
 * dc:description), if any.
 *
 * @param {object|null} exif
 * @returns {string|null}
 */
export function descriptionFromExif(exif) {
  if (!exif) return null;
  const source = DESCRIPTION_FIELDS.map((key) => exif[key]).find((value) => value !== undefined);
  return flattenLangAlt(source);
}
