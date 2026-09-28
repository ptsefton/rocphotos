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

  /* People browser: a scrollable, searchable list of everyone depicted,
     each opening a panel of their own photos. Driven by a hidden radio
     per person (checked by a <label> in the list) rather than :target,
     deliberately: the image viewer below already owns the URL fragment,
     and radio state is independent of it, so opening a photo from
     someone's panel leaves that panel open underneath to come back to.
     A radio sits at the top of <body>, before everything it controls, so
     both the list and the panels are later siblings it can select. */
  .person-radio { display: none; }
  .people-browser { margin-bottom: 1.5rem; max-width: 26rem; }
  .people-browser h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  .person-search { width: 100%; box-sizing: border-box; padding: 0.35rem 0.5rem; font: inherit; font-size: 0.9rem; border: 1px solid #bbb; border-radius: 4px; margin-bottom: 0.4rem; }
  .person-list { max-height: 15rem; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; }
  .person-list label { display: flex; justify-content: space-between; gap: 0.6rem; padding: 0.3rem 0.6rem; cursor: pointer; border-bottom: 1px solid #f0f0f0; font-size: 0.9rem; }
  .person-list label:last-child { border-bottom: none; }
  .person-list label:hover { background: #f5f5f5; }
  .person-list .count { color: #888; font-size: 0.85em; white-space: nowrap; }
  .person-list .empty { padding: 0.4rem 0.6rem; color: #888; font-size: 0.85rem; }

  /* Opens inline, directly under the list, rather than as a full-screen
     overlay: an overlay covers the very list it was opened from, so
     looking at several people in turn would mean closing each one first.
     Being in the page flow also keeps it clear of the image viewer
     below, which is the one thing here that does take over the screen. */
  .person-panel { display: none; position: relative; border: 1px solid #ddd; border-radius: 4px; padding: 0.8rem; margin-bottom: 1.5rem; }
  .person-panel h3 { margin: 0 0 0.8rem; }
  .person-panel .person-panel-count { color: #888; font-weight: normal; font-size: 0.8em; }
  .person-panel-close { position: absolute; top: 0.3rem; right: 0.7rem; color: #555; font-size: 1.5rem; line-height: 1; cursor: pointer; }
  .person-panel-close:hover { color: #000; }
  .person-panel figcaption .path { color: #888; }

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

// How many of one person's photos the root-level preview embeds. A
// sub-collection's own page shows all of theirs (it is bounded by the
// directory's size anyway); the root page would otherwise carry every
// thumbnail of everyone across the whole collection, which for a
// decades-spanning one is megabytes of HTML nobody asked to load.
export const ROOT_PERSON_THUMBNAIL_LIMIT = 24;

// The one thing here CSS genuinely cannot do: narrow a list by typed
// text. Kept to this — everything else (opening a person, closing them,
// highlighting the current one) is plain CSS, and the list is complete
// and usable with the script absent or blocked, which is why the search
// box starts hidden and is revealed here rather than being hidden on
// failure. Inline, like the stylesheet, so a preview page stays a
// single self-contained file that works over file://.
const PERSON_SEARCH_SCRIPT = `
for (const browser of document.querySelectorAll('.people-browser')) {
  const input = browser.querySelector('.person-search');
  const labels = [...browser.querySelectorAll('.person-list label')];
  const empty = browser.querySelector('.person-list .empty');
  input.hidden = false;
  input.addEventListener('input', () => {
    const typed = input.value.trim().toLowerCase();
    let shown = 0;
    for (const label of labels) {
      const match = !typed || label.dataset.name.toLowerCase().includes(typed);
      label.style.display = match ? '' : 'none';
      if (match) shown++;
    }
    empty.hidden = shown > 0;
  });
}
`;

/**
 * The searchable, scrollable people box plus one hidden panel of photos
 * per person — shared by both preview levels, which differ only in what
 * each thumbnail links to (see their own callers).
 *
 * Returns the three pieces separately because they belong at different
 * places in the document: the radios must come first (everything they
 * control is selected as a later sibling), the box sits in the page
 * body, and the panels are overlays that go last.
 *
 * @param {Array<{name: string, total: number, thumbs: Array<{src: string, href: string, alt: string, caption: string, sub?: string|null}>}>} people
 * @returns {{radios: string, box: string, panels: string}} empty strings when nobody is depicted
 */
function renderPeopleBrowser(people) {
  if (people.length === 0) return { radios: '', box: '', panels: '' };

  const radios = [`<input type="radio" name="person-panel" id="person-none" class="person-radio" checked />`]
    .concat(people.map((_, index) => `<input type="radio" name="person-panel" id="person-${index}" class="person-radio" />`))
    .join('\n');

  const listItems = people
    .map((person, index) => `  <label for="person-${index}" data-name="${escapeHtml(person.name)}"><span>${escapeHtml(person.name)}</span><span class="count">${person.total}</span></label>`)
    .join('\n');

  const box = `<div class="people-browser">
  <h2>People</h2>
  <input type="search" class="person-search" placeholder="Search people" autocomplete="off" hidden />
  <div class="person-list">
${listItems}
  <div class="empty" hidden>No matching people.</div>
  </div>
</div>`;

  const panels = `<div class="person-panels">
${people.map((person, index) => {
    const shownCount = person.thumbs.length < person.total
      ? ` <span class="person-panel-count">showing ${person.thumbs.length} of ${person.total}</span>`
      : '';
    const figures = person.thumbs.map((thumb) => `    <figure>
      <a href="${thumb.href}"><img src="${thumb.src}" alt="${escapeHtml(thumb.alt)}" loading="lazy" /></a>
      <figcaption>
        <div class="name">${escapeHtml(thumb.caption)}</div>
        ${thumb.sub ? `<div class="path">${escapeHtml(thumb.sub)}</div>` : ''}
      </figcaption>
    </figure>`).join('\n');

    return `  <div class="person-panel" id="person-photos-${index}">
    <label for="person-none" class="person-panel-close" title="Close" role="button" aria-label="Close">&times;</label>
    <h3>${escapeHtml(person.name)}${shownCount}</h3>
    <div class="grid">
${figures}
    </div>
  </div>`;
  }).join('\n')}
</div>`;

  return { radios, box, panels };
}

// One pair of rules per person: show their panel, and mark them as the
// current one in the list. Generated rather than written by hand because
// CSS cannot correlate a checked input with an arbitrary other element
// without naming both.
function personBrowserStyle(peopleCount) {
  if (peopleCount === 0) return '';
  const rules = [];
  for (let index = 0; index < peopleCount; index++) {
    rules.push(`#person-${index}:checked ~ .person-panels > #person-photos-${index} { display: block; }`);
    rules.push(`#person-${index}:checked ~ .people-browser .person-list label[for="person-${index}"] { background: #eef4fc; font-weight: 600; }`);
  }
  return `\n${rules.join('\n')}\n`;
}

function page(title, backLink, body, { peopleCount = 0 } = {}) {
  const backHtml = backLink
    ? `<p><a href="${encodePath(backLink)}">&larr; Back to collection</a></p>`
    : '';
  const scriptHtml = peopleCount > 0 ? `<script>${PERSON_SEARCH_SCRIPT}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${SHARED_STYLE}${personBrowserStyle(peopleCount)}</style>
</head>
<body>
${backHtml}
${body}
${scriptHtml}
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
    const errorHtml = image.processingError
      ? `<div class="error">${escapeHtml(image.processingError)}</div>`
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

  // Everyone depicted here, each of their photos pointing at the very
  // same in-page viewer the main grid above uses — no second copy of
  // anything, and closing a photo drops back to the person's panel,
  // still open behind it.
  const byPerson = new Map();
  images.forEach((image, index) => {
    for (const person of image.people ?? []) {
      if (!byPerson.has(person)) byPerson.set(person, []);
      byPerson.get(person).push({
        src: encodePath(image.thumbnailPath ?? image.path),
        href: `#viewer-${index}`,
        alt: image.name,
        caption: image.name,
        sub: formatDate(image.dateCreated),
      });
    }
  });
  const people = [...byPerson.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([personName, thumbs]) => ({ name: personName, total: thumbs.length, thumbs }));
  const { radios, box, panels } = renderPeopleBrowser(people);

  const body = `${radios}
<header>
  <h1>${escapeHtml(name)}</h1>
  <p>${images.length} image${images.length === 1 ? '' : 's'}</p>
</header>
${box}
${panels}
<div class="grid">
${figures.join('\n')}
</div>
${viewers.join('\n')}`;

  return page(name, backLink, body, { peopleCount: people.length });
}

/**
 * Renders the static preview page for the root crate: date-based
 * navigation into each sub-collection crate, organised as collapsible
 * year, then month, sections (so that a collection spanning decades stays
 * manageable), sorted chronologically with the most recent first. Only the
 * most recent year, and its most recent month, are expanded by default.
 * Sub-collections with no dated images are listed separately as undated.
 *
 * Also carries a people browser covering the whole collection (see
 * renderPeopleBrowser). Unlike a sub-collection's own page, its
 * thumbnails link straight to the image file rather than to an in-page
 * viewer: the root page holds no images of its own, so every viewer
 * would be a second copy of markup that only exists to be opened once,
 * and a collection-wide set of them is exactly what
 * ROOT_PERSON_THUMBNAIL_LIMIT exists to keep in check.
 *
 * @param {object} options
 * @param {string} options.name - root dataset name
 * @param {Array<{path: string, imageCount: number, representativeDate: string|null}>} options.subCrates
 * @param {Array<{name: string, total: number, images: Array<{path: string, thumbnailPath: string, name: string, subCollection: string}>}>} [options.people] - collection-wide, already capped and ordered by the caller (see previews.js)
 * @returns {string} HTML document
 */
export function renderRootCratePreview({ name, subCrates, people = [] }) {
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

  const { radios, box, panels } = renderPeopleBrowser(people.map((person) => ({
    name: person.name,
    total: person.total,
    thumbs: person.images.map((image) => ({
      src: encodePath(image.thumbnailPath),
      href: encodePath(image.path),
      alt: image.name,
      caption: image.name,
      sub: image.subCollection,
    })),
  })));

  const body = `${radios}
<header>
  <h1>${escapeHtml(name)}</h1>
  <p>${subCrates.length} sub-collection${subCrates.length === 1 ? '' : 's'}</p>
</header>
${box}
${panels}
${yearSections}
${undatedSection}`;

  return page(name, null, body, { peopleCount: people.length });
}
