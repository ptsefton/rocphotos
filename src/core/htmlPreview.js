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
  /* These pages are opened straight off the filesystem as often as they
     are served, so everything is self-contained: no webfonts, no
     stylesheet to fetch, and (apart from the people search) no script.
     Tokens match the app's own look so a collection browsed at rest and
     the same collection in rocphotos do not feel like two products. */
  :root {
    --bg: #f6f6f4;
    --panel: #ffffff;
    --panel-2: #fafaf8;
    --ink: #16161a;
    --muted: #62626b;
    --border: #d9d9d4;
    --accent: #1f5fbf;
    --accent-ink: #ffffff;
    --accent-soft: #eaf1fc;
    --error: #b3261e;
    --radius: 10px;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121214;
      --panel: #1b1b1f;
      --panel-2: #222227;
      --ink: #ececef;
      --muted: #a0a0aa;
      --border: #34343b;
      --accent: #7aa7ff;
      --accent-ink: #0b1020;
      --accent-soft: #1d2740;
      --error: #ff8a80;
      color-scheme: dark;
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.5rem 4rem; max-width: 72rem;
    background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  a { color: var(--accent); }
  header { margin-bottom: 1.75rem; }
  header h1 { margin: 0; font-size: 1.6rem; letter-spacing: -0.01em; }
  header p { color: var(--muted); margin: 6px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; }
  figure {
    margin: 0; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 0.5rem; overflow: hidden;
    transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s;
  }
  figure:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgb(0 0 0 / 0.08); transform: translateY(-1px); }
  figure img { width: 100%; height: 140px; object-fit: cover; border-radius: 6px; background: var(--panel-2); cursor: pointer; display: block; }
  figcaption { font-size: 0.8rem; margin-top: 0.45rem; word-break: break-word; }
  figcaption .date { color: var(--muted); }
  figcaption .error { color: var(--error); }
  details.exif summary { cursor: pointer; color: var(--muted); font-size: 0.78rem; }
  details.exif table { border-collapse: collapse; font-size: 0.75rem; margin-top: 0.3rem; width: 100%; }
  details.exif th, details.exif td { padding: 0.15rem 0.4rem; border-bottom: 1px solid var(--border); text-align: left; }
  details.exif th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  section { margin-bottom: 1.5rem; }
  section h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; font-size: 1.05rem; }
  ul.nav-list { list-style: none; padding: 0; margin: 0.4rem 0 0; }
  ul.nav-list li { padding: 0.35rem 0.5rem; border-radius: 6px; }
  ul.nav-list li:hover { background: var(--accent-soft); }
  ul.nav-list .path { color: var(--muted); font-size: 0.85em; }
  details.year {
    margin-bottom: 0.6rem; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 0.6rem 0.9rem;
  }
  details.year > summary { cursor: pointer; }
  details.year > summary h2 { display: inline-block; margin: 0; border-bottom: none; padding-bottom: 0; font-size: 1.05rem; }
  details.month { margin: 0.5rem 0 0.2rem 1.2rem; }
  details.month > summary { cursor: pointer; font-weight: 600; color: var(--muted); }

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
  .person-panel .person-panel-count { color: var(--muted); font-weight: normal; font-size: 0.8em; }
  /* Caps the panel at roughly three rows and scrolls the rest. Every
     thumbnail in it is loading="lazy", so a person with two thousand
     photos costs two thousand <img> tags in the file but only the dozen
     rows someone actually scrolls past in fetched bytes. */
  .person-panel-grid { max-height: 30rem; overflow-y: auto; padding: 2px; }
  .person-panel-close { position: absolute; top: 0.3rem; right: 0.7rem; color: #555; font-size: 1.5rem; line-height: 1; cursor: pointer; }
  .person-panel-close:hover { color: #000; }
  .person-panel figcaption .path { color: #888; }

  /* Full-screen image viewer: a pure-CSS, JavaScript-free lightbox. Each
     image gets a #viewer-N target; the thumbnail links to it and the
     overlay is shown only while its id matches the URL fragment, which
     works identically whether the page is served or opened via file://. */
  .viewer { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.93); z-index: 100; padding: 2rem; align-items: center; justify-content: center; }
  .viewer:target { display: flex; }
  /* A full-bleed link behind the photo, so clicking anywhere around it
     goes back to the grid — the usual lightbox behaviour, with nothing
     but an anchor doing it. The content sits above it, so a click on the
     photo, caption or EXIF table does not close. */
  .viewer-backdrop { position: absolute; inset: 0; cursor: zoom-out; }
  .viewer-content {
    position: relative; z-index: 1; display: flex; flex-direction: column;
    align-items: center; gap: 0.9rem; max-width: 100%;
  }
  .viewer img { max-width: 100%; max-height: 78vh; object-fit: contain; border-radius: 6px; }
  .viewer-close { position: fixed; top: 1rem; right: 1.5rem; z-index: 2; color: #fff; font-size: 2rem; line-height: 1; text-decoration: none; opacity: 0.75; }
  .viewer-close:hover { opacity: 1; }
  /* Previous/next, as plain links to the adjacent image's own target. */
  .viewer-nav {
    position: fixed; top: 50%; transform: translateY(-50%); z-index: 2;
    color: #fff; font-size: 2.5rem; line-height: 1; text-decoration: none;
    padding: 0.5rem 0.8rem; border-radius: 8px; background: rgb(255 255 255 / 0.08);
  }
  .viewer-nav:hover { background: rgb(255 255 255 / 0.2); }
  .viewer-nav.is-disabled { opacity: 0.2; background: none; }
  .viewer-prev { left: 1rem; }
  .viewer-next { right: 1rem; }
  .viewer .viewer-caption { color: #eee; margin: 0; text-align: center; }
  .viewer-position { color: #9a9aa2; font-size: 0.85em; margin-left: 0.4rem; }
  .viewer-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; justify-content: center; margin: 0; }
  .viewer-action {
    color: #eee; background: rgb(255 255 255 / 0.1); border-radius: 8px;
    padding: 0.35rem 0.8rem; font-size: 0.85rem; font-weight: 600; text-decoration: none;
  }
  .viewer-action:hover { background: rgb(255 255 255 / 0.22); }
  .viewer .error { color: #ff8a80; }
  .viewer details.exif { color: #eee; max-width: 90vw; max-height: 18vh; overflow: auto; }
  .viewer details.exif summary { color: #fff; }
  .viewer details.exif th { color: #ccc; }
  .viewer details.exif th, .viewer details.exif td { border-bottom-color: rgba(255, 255, 255, 0.2); }

  @media (max-width: 560px) {
    body { padding: 1.5rem 1rem 3rem; }
    .viewer { padding: 1rem; }
    .viewer-nav { font-size: 2rem; padding: 0.4rem 0.55rem; }
  }
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
 * One full-screen viewer: the photo, its caption, and links to step to
 * the neighbouring photos or back out to the page underneath.
 *
 * Every part of it is an anchor to a `:target`, so stepping through a
 * set needs no script. `prevId`/`nextId` are omitted at the ends of the
 * set, which renders a dimmed non-link in place of the arrow so the
 * controls never shift position between photos.
 *
 * @param {{id: string, src: string, alt: string, caption: string, sub?: string|null, position?: string|null, prevId?: string|null, nextId?: string|null, extraHtml?: string}} options
 * @returns {string}
 */
function renderViewer({ id, src, alt, caption, sub = null, position = null, prevId = null, nextId = null, extraHtml = '' }) {
  const arrow = (targetId, className, label, glyph) => (targetId
    ? `<a class="viewer-nav ${className}" href="#${targetId}" aria-label="${label}">${glyph}</a>`
    : `<span class="viewer-nav ${className} is-disabled" aria-hidden="true">${glyph}</span>`);

  return `<div id="${id}" class="viewer">
  <a class="viewer-backdrop" href="#" aria-label="Close"></a>
  <a href="#" class="viewer-close" aria-label="Close">&times;</a>
  ${arrow(prevId, 'viewer-prev', 'Previous image', '&#8249;')}
  ${arrow(nextId, 'viewer-next', 'Next image', '&#8250;')}
  <div class="viewer-content">
    <img src="${src}" alt="${escapeHtml(alt)}" loading="lazy" />
    <p class="viewer-caption">${escapeHtml(caption)}${sub ? ` &mdash; ${escapeHtml(sub)}` : ''}${position ? ` <span class="viewer-position">${position}</span>` : ''}</p>
${extraHtml}
  </div>
</div>`;
}

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
    const figures = person.thumbs.map((thumb) => `    <figure>
      <a href="${thumb.href}"><img src="${thumb.src}" alt="${escapeHtml(thumb.alt)}" loading="lazy" /></a>
      <figcaption>
        <div class="name">${escapeHtml(thumb.caption)}</div>
        ${thumb.sub ? `<div class="path">${escapeHtml(thumb.sub)}</div>` : ''}
      </figcaption>
    </figure>`).join('\n');

    return `  <div class="person-panel" id="person-photos-${index}">
    <label for="person-none" class="person-panel-close" title="Close" role="button" aria-label="Close">&times;</label>
    <h3>${escapeHtml(person.name)} <span class="person-panel-count">${person.thumbs.length} photo${person.thumbs.length === 1 ? '' : 's'}</span></h3>
    <div class="grid person-panel-grid">
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

// Path order, so viewer numbering does not depend on the caller.
function images_sortByPath(images) {
  return [...images].sort((a, b) => a.path.localeCompare(b.path));
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
export function renderSubCratePreview({ name, images: unorderedImages, backLink = null }) {
  // Sorted by path before anything is numbered, so `#viewer-3` means the
  // same photo whoever rendered the page. A scan hands these over in
  // directory order and regeneratePreviews in id order, which used to
  // number the same folder's viewers differently depending on which had
  // written the page last — and the root page's "view in folder" links
  // point at these numbers.
  const images = [...images_sortByPath(unorderedImages)];
  const figures = [];
  const viewers = [];

  images.forEach((image, index) => {
    const viewerId = `viewer-${index}`;
    const thumbSrc = encodePath(image.thumbnailPath ?? image.path);
    const fullSrc = encodePath(image.path);
    const dateLabel = formatDate(image.dateCreated);
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

    viewers.push(renderViewer({
      id: viewerId,
      src: fullSrc,
      alt: image.name,
      caption: image.name,
      sub: dateLabel,
      position: `${index + 1} of ${images.length}`,
      prevId: index > 0 ? `viewer-${index - 1}` : null,
      nextId: index < images.length - 1 ? `viewer-${index + 1}` : null,
      extraHtml: [errorHtml, exifDetailsHtml].filter(Boolean).map((h) => `    ${h}`).join('\n'),
    }));
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
 * renderPeopleBrowser). A person's panel lists every photo of them, in
 * a grid that scrolls rather than growing the page, and each photo
 * opens a viewer that steps through that person's own set.
 *
 * @param {object} options
 * @param {string} options.name - root dataset name
 * @param {Array<{path: string, imageCount: number, representativeDate: string|null}>} options.subCrates
 * @param {Array<{name: string, total: number, images: Array<{path: string, thumbnailPath: string, name: string, subCollection: string}>}>} [options.people] - collection-wide, ordered by the caller (see previews.js)
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

  // Each person's photos open a viewer that steps through that person's
  // own set, so "next" means the next photo of them rather than the next
  // photo in the collection. That means one viewer per (person, photo)
  // rather than per photo: a photo showing three people appears in three
  // people's sets, and each needs its own place in each sequence. The
  // markup is cheap — the bytes are not, and both the thumbnails and the
  // viewers' own images are lazy, so a browser fetches only what someone
  // actually scrolls to or opens.
  const personViewers = [];
  const { radios, box, panels } = renderPeopleBrowser(people.map((person, personIndex) => ({
    name: person.name,
    total: person.total,
    thumbs: person.images.map((image, imageIndex) => {
      const viewerId = `person-${personIndex}-photo-${imageIndex}`;
      // Two ways out of a photo, beyond closing it: to the folder it
      // actually lives in (landing on this same photo there, which is
      // why renderSubCratePreview numbers its viewers by path), and back
      // to the list of this person's photos, which is where the reader
      // came from.
      const folderLink = image.subCollectionPreview
        ? `<a class="viewer-action" href="${encodePath(image.subCollectionPreview)}#viewer-${image.indexInSubCollection}">View folder collection &rsaquo;</a>`
        : '';
      const actions = `    <p class="viewer-actions">
      <a class="viewer-action" href="#">&lsaquo; Back to the list</a>
      ${folderLink}
    </p>`;

      personViewers.push(renderViewer({
        id: viewerId,
        src: encodePath(image.path),
        alt: image.name,
        caption: image.name,
        sub: image.subCollection,
        position: `${imageIndex + 1} of ${person.images.length}`,
        prevId: imageIndex > 0 ? `person-${personIndex}-photo-${imageIndex - 1}` : null,
        nextId: imageIndex < person.images.length - 1 ? `person-${personIndex}-photo-${imageIndex + 1}` : null,
        extraHtml: actions,
      }));
      return {
        src: encodePath(image.thumbnailPath),
        href: `#${viewerId}`,
        alt: image.name,
        caption: image.name,
        sub: image.subCollection,
      };
    }),
  })));

  const body = `${radios}
<header>
  <h1>${escapeHtml(name)}</h1>
  <p>${subCrates.length} sub-collection${subCrates.length === 1 ? '' : 's'}</p>
</header>
${box}
${panels}
${yearSections}
${undatedSection}
${personViewers.join('\n')}`;

  return page(name, null, body, { peopleCount: people.length });
}
