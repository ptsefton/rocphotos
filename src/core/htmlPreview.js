export const PREVIEW_FILE_NAME = 'ro-crate-preview.html';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The earliest dateCreated among a sub-collection's images, used as its
 * representative date for the root crate's date-based navigation. Returns
 * null if none of the images have a known date.
 *
 * @param {Array<{dateCreated: string|null}>} images
 * @returns {string|null}
 */
export function earliestDate(images) {
  const dates = images.map((image) => image.dateCreated).filter(Boolean).sort();
  return dates.length > 0 ? dates[0] : null;
}

const SHARED_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  a { color: #1a5fb4; }
  header { margin-bottom: 1.5rem; }
  header p { color: #555; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1rem; }
  figure { margin: 0; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem; }
  figure img { width: 100%; height: 120px; object-fit: cover; border-radius: 2px; background: #eee; cursor: pointer; }
  figcaption { font-size: 0.8rem; margin-top: 0.4rem; word-break: break-word; }
  figcaption .date { color: #888; }
  figcaption .error { color: #b00020; }
  details.exif summary { cursor: pointer; color: #555; }
  details.exif table { border-collapse: collapse; font-size: 0.75rem; margin-top: 0.3rem; width: 100%; }
  details.exif th, details.exif td { padding: 0.15rem 0.4rem; border-bottom: 1px solid #eee; text-align: left; }
  details.exif th { color: #555; font-weight: 600; white-space: nowrap; }
  section { margin-bottom: 1.5rem; }
  section h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  ul.nav-list { list-style: none; padding: 0; }
  ul.nav-list li { padding: 0.3rem 0; }
  ul.nav-list .path { color: #888; font-size: 0.85em; }
  details.year { margin-bottom: 0.5rem; }
  details.year > summary { cursor: pointer; }
  details.year > summary h2 { display: inline-block; margin: 0; border-bottom: none; padding-bottom: 0; }
  details.month { margin: 0.4rem 0 0.4rem 1.5rem; }
  details.month > summary { cursor: pointer; font-weight: 600; }

  /* Full-screen image viewer: a pure-CSS, JavaScript-free lightbox. Each
     image gets a #viewer-N target; the thumbnail links to it and the
     overlay is shown only while its id matches the URL fragment, which
     works identically whether the page is served or opened via file://. */
  .viewer { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.92); z-index: 100; box-sizing: border-box; padding: 2rem; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; }
  .viewer:target { display: flex; }
  .viewer img { max-width: 100%; max-height: 78vh; object-fit: contain; }
  .viewer-close { position: fixed; top: 1rem; right: 1.5rem; color: #fff; font-size: 2rem; line-height: 1; text-decoration: none; }
  .viewer .viewer-caption { color: #eee; }
  .viewer .error { color: #ff8a80; }
  .viewer details.exif { color: #eee; max-width: 90vw; max-height: 18vh; overflow: auto; }
  .viewer details.exif summary { color: #fff; }
  .viewer details.exif th { color: #ccc; }
  .viewer details.exif th, .viewer details.exif td { border-bottom-color: rgba(255, 255, 255, 0.2); }
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// encodeURI() is not sufficient here: it deliberately leaves characters
// such as '#', '?', '%' and '&' unescaped because it assumes it is encoding
// an already-structured URI. A relative path built from real filenames can
// legitimately contain any of those characters, and left unescaped they
// would be misread as a fragment, query string, or existing escape by the
// browser, breaking the link outright under file://. Each path segment is
// therefore encoded individually with encodeURIComponent, preserving the
// '/' separators between segments.
function encodePath(relPath) {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

function formatDate(isoDateTime) {
  return isoDateTime ? isoDateTime.slice(0, 10) : null;
}

function renderExifTable(exifEntries) {
  if (!exifEntries || exifEntries.length === 0) return '';
  const rows = exifEntries
    .map((entry) => `<tr><th>${escapeHtml(entry.name)}</th><td>${escapeHtml(entry.value)}</td></tr>`)
    .join('\n');
  return `<table>
${rows}
</table>`;
}

function page(title, backLink, body) {
  const backHtml = backLink
    ? `<p><a href="${encodePath(backLink)}">&larr; Back to collection</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
${backHtml}
${body}
</body>
</html>
`;
}

/**
 * Renders the static preview page for a sub-collection crate: a thumbnail
 * grid of every image it contains, each opening a full-screen, in-page
 * viewer (sized to fit the screen, with an expandable EXIF table) rather
 * than linking straight to the raw image file.
 *
 * @param {object} options
 * @param {string} options.name - crate/dataset name
 * @param {Array<{path: string, name: string, dateCreated: string|null, description: string|null, thumbnailPath: string|null, exifEntries?: Array<{name: string, value: string}>}>} options.images
 * @param {string|null} [options.backLink] - relative path back to the root crate's preview page
 * @returns {string} HTML document
 */
export function renderSubCratePreview({ name, images, backLink = null }) {
  const figures = [];
  const viewers = [];

  images.forEach((image, index) => {
    const viewerId = `viewer-${index}`;
    const thumbSrc = encodePath(image.thumbnailPath ?? image.path);
    const fullSrc = encodePath(image.path);
    const dateLabel = formatDate(image.dateCreated);
    const captionSuffix = dateLabel ? ` &mdash; ${escapeHtml(dateLabel)}` : '';
    const errorHtml = image.description
      ? `<div class="error">${escapeHtml(image.description)}</div>`
      : '';
    const exifTableHtml = renderExifTable(image.exifEntries);
    const exifDetailsHtml = exifTableHtml
      ? `<details class="exif">
  <summary>EXIF</summary>
  ${exifTableHtml}
</details>`
      : '';

    figures.push(`<figure>
  <a href="#${viewerId}">
    <img src="${thumbSrc}" alt="${escapeHtml(image.name)}" loading="lazy" />
  </a>
  <figcaption>
    <div class="name">${escapeHtml(image.name)}</div>
    ${dateLabel ? `<div class="date">${escapeHtml(dateLabel)}</div>` : ''}
    ${errorHtml}
    ${exifDetailsHtml}
  </figcaption>
</figure>`);

    viewers.push(`<div id="${viewerId}" class="viewer">
  <a href="#" class="viewer-close" aria-label="Close">&times;</a>
  <img src="${fullSrc}" alt="${escapeHtml(image.name)}" />
  <p class="viewer-caption">${escapeHtml(image.name)}${captionSuffix}</p>
  ${errorHtml}
  ${exifDetailsHtml}
</div>`);
  });

  const body = `<header>
  <h1>${escapeHtml(name)}</h1>
  <p>${images.length} image${images.length === 1 ? '' : 's'}</p>
</header>
<div class="grid">
${figures.join('\n')}
</div>
${viewers.join('\n')}`;

  return page(name, backLink, body);
}

/**
 * Renders the static preview page for the root crate: date-based
 * navigation into each sub-collection crate, organised as collapsible
 * year, then month, sections (so that a collection spanning decades stays
 * manageable), sorted chronologically with the most recent first. Only the
 * most recent year, and its most recent month, are expanded by default.
 * Sub-collections with no dated images are listed separately as undated.
 *
 * @param {object} options
 * @param {string} options.name - root dataset name
 * @param {Array<{path: string, imageCount: number, representativeDate: string|null}>} options.subCrates
 * @returns {string} HTML document
 */
export function renderRootCratePreview({ name, subCrates }) {
  const dated = subCrates.filter((sc) => sc.representativeDate);
  const undated = subCrates.filter((sc) => !sc.representativeDate);

  const byYear = new Map();
  for (const sc of dated) {
    const year = sc.representativeDate.slice(0, 4);
    const month = sc.representativeDate.slice(5, 7);
    if (!byYear.has(year)) byYear.set(year, new Map());
    const byMonth = byYear.get(year);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(sc);
  }

  const years = [...byYear.keys()].sort().reverse();

  const renderLink = (sc) => {
    const label = formatDate(sc.representativeDate) ?? sc.path;
    return `<li>
  <a href="${encodePath(sc.path)}/${PREVIEW_FILE_NAME}">${escapeHtml(label)}</a>
  <span class="path">(${escapeHtml(sc.path)}) &mdash; ${sc.imageCount} image${sc.imageCount === 1 ? '' : 's'}</span>
</li>`;
  };

  const yearSections = years
    .map((year, yearIndex) => {
      const byMonth = byYear.get(year);
      const months = [...byMonth.keys()].sort().reverse();

      const monthSections = months
        .map((month, monthIndex) => {
          const entries = [...byMonth.get(month)].sort((a, b) => (a.representativeDate < b.representativeDate ? 1 : -1));
          const monthName = MONTH_NAMES[Number(month) - 1] ?? month;
          const open = yearIndex === 0 && monthIndex === 0 ? ' open' : '';
          return `<details class="month"${open}>
  <summary>${escapeHtml(monthName)}</summary>
  <ul class="nav-list">
${entries.map(renderLink).join('\n')}
  </ul>
</details>`;
        })
        .join('\n');

      const open = yearIndex === 0 ? ' open' : '';
      return `<details class="year"${open}>
  <summary><h2>${escapeHtml(year)}</h2></summary>
${monthSections}
</details>`;
    })
    .join('\n');

  const undatedSection = undated.length
    ? `<section>
  <h2>Undated</h2>
  <ul class="nav-list">
${undated.map(renderLink).join('\n')}
  </ul>
</section>`
    : '';

  const body = `<header>
  <h1>${escapeHtml(name)}</h1>
  <p>${subCrates.length} sub-collection${subCrates.length === 1 ? '' : 's'}</p>
</header>
${yearSections}
${undatedSection}`;

  return page(name, null, body);
}
