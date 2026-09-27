import { renderOverviewTree, selectedOverviewPaths, setAllCrateCheckboxes } from './overviewUI.js';

const IMAGE_ENTITY_TYPE = 'http://pcdm.org/models#Object';
const FACET_NAMES = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'albums', 'year'];
const FACET_LABELS = { camera: 'Camera', lens: 'Lens', keyword: 'Keywords', rating: 'Rating', people: 'People', pets: 'Pets', albums: 'Albums', year: 'Year', month: 'Month', day: 'Day', memberOf: 'Collection' };
const FACET_ICONS = { people: '👤', pets: '🐕', keyword: '🏷️', albums: '📁' };

// ro-crate-js wraps a scalar-assigned property (e.g. an image entity's
// own dateCreated — see crateBuilder.js's own unwrap, which handles this
// same quirk server-side for internal use) in a one-element array when
// read back — the raw, resolved metadata document GET
// /entity/{id}/metadata returns is not re-normalized out of this, so any
// caller reading such a field here has to.
function unwrapJsonLdValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function labelWithIcon(facetName) {
  const icon = FACET_ICONS[facetName];
  return icon ? `${icon} ${FACET_LABELS[facetName]}` : FACET_LABELS[facetName];
}

const facetsEl = document.querySelector('#facets');
const activeFiltersEl = document.querySelector('#active-filters');
const collectionsAllEl = document.querySelector('#collections-all');
const collectionsTreeEl = document.querySelector('#collections-tree');
const datesAllEl = document.querySelector('#dates-all');
const datesTreeEl = document.querySelector('#dates-tree');
const albumsListEl = document.querySelector('#albums-list');
const exportAlbumButtonEl = document.querySelector('#export-album-button');
const modeButtonEls = { explore: document.querySelector('#mode-explore'), scan: document.querySelector('#mode-scan'), settings: document.querySelector('#mode-settings') };
const screenEls = { explore: document.querySelector('#explore-screen'), scan: document.querySelector('#scan-screen'), settings: document.querySelector('#settings-screen') };
const adminStatusEl = document.querySelector('#admin-status');
const overviewSectionEl = document.querySelector('#overview-section');
const overviewTreeEl = document.querySelector('#overview-tree');
const overviewSelectAllButtonEl = document.querySelector('#overview-select-all');
const overviewSelectNoneButtonEl = document.querySelector('#overview-select-none');
const overviewRefreshButtonEl = document.querySelector('#overview-refresh');
const overviewProcessButtonEl = document.querySelector('#overview-process');
const settingsStatusEl = document.querySelector('#settings-status');
const settingsFormEl = document.querySelector('#settings-form');
const settingsWriteMetadataCheckbox = document.querySelector('#settings-write-metadata');
const settingsExcludeDirsEl = document.querySelector('#settings-exclude-dirs');
const settingsExcludeFilesEl = document.querySelector('#settings-exclude-files');

// Every album, by id, from the same fetch that fills the sidebar's
// Albums panel (see loadAlbumsList) — kept around so the top-bar Export
// Album button (see updateExportAlbumButton) can look up the id it
// needs from just the name held in activeFilters.albums, without a
// separate request.
let albumsById = new Map();
const statusEl = document.querySelector('#status');
const selectAllButtonEl = document.querySelector('#select-all');
const gridEl = document.querySelector('#grid');
const selectionBarEl = document.querySelector('#selection-bar');
const selectionCountEl = document.querySelector('#selection-count');
const keywordDialogEl = document.querySelector('#keyword-dialog');
const keywordDialogDescriptionEl = document.querySelector('#keyword-dialog-description');
const keywordChipListEl = document.querySelector('#keyword-chip-list');
const keywordInputEl = document.querySelector('#keyword-input');
const keywordDatalistEl = document.querySelector('#keyword-datalist');
const keywordSuggestionsListEl = document.querySelector('#keyword-suggestions-list');
const personDialogEl = document.querySelector('#person-dialog');
const personDialogDescriptionEl = document.querySelector('#person-dialog-description');
const personInputEl = document.querySelector('#person-input');
const personDatalistEl = document.querySelector('#person-datalist');
const personSuggestionsListEl = document.querySelector('#person-suggestions-list');
const newAlbumDialogEl = document.querySelector('#new-album-dialog');
const newAlbumNameEl = document.querySelector('#new-album-name');
const newAlbumDescriptionEl = document.querySelector('#new-album-description');
const albumPickerDialogEl = document.querySelector('#album-picker-dialog');
const albumPickerDescriptionEl = document.querySelector('#album-picker-description');
const albumPickerInputEl = document.querySelector('#album-picker-input');
const albumPickerListEl = document.querySelector('#album-picker-list');
const viewerEl = document.querySelector('#viewer');
const viewerImageEl = document.querySelector('#viewer-image');
const viewerRatingEl = document.querySelector('#viewer-rating');
const viewerCaptionEl = document.querySelector('#viewer-caption');
const viewerDescriptionEl = document.querySelector('#viewer-description');
const viewerTagsEl = document.querySelector('#viewer-tags');
const viewerMetadataEl = document.querySelector('#viewer-metadata');
const viewerBreadcrumbEl = document.querySelector('#viewer-breadcrumb');
const viewerPrevEl = document.querySelector('#viewer-prev');
const viewerNextEl = document.querySelector('#viewer-next');
const viewerFacesEl = document.querySelector('#viewer-faces');
const viewerFacesToggleEl = document.querySelector('#viewer-faces-toggle');
const recognizeFacesButtonEl = document.querySelector('#recognize-faces-button');
const facesReviewEl = document.querySelector('#faces-review');
const facesReviewListEl = document.querySelector('#faces-review-list');

// Face regions (with a bounding box) for the entity currently open in the
// viewer, redrawn whenever the overlay is shown and whenever the image's
// own rendered size changes (window resize, or a new image loading).
let currentFaceRegions = [];

// The id of whichever entity is currently open in the viewer, for its own
// quick edit actions (Add keyword / Set rating / Delete there act on just
// this one image, independent of whatever is selected in the grid).
let currentViewerEntityId = null;

// Ids of grid tiles the user has checked, for the bulk edit actions in
// the selection bar. Cleared on every fresh search() — after an edit,
// the entities it applied to may no longer match the current filters
// (a deleted image, or one whose new rating no longer matches an active
// rating filter) or even still be on screen, so carrying the same ids
// forward into a new result set would be more surprising than useful.
let selectedIds = new Set();

// The ids currently rendered in the grid, for "Select All" — only ever
// selects what is actually on screen for the current search, not every
// entity matching it (the search itself is capped at 200 results; there
// is no pagination yet for "all" to mean more than that).
let currentEntityIds = [];

// The full entities currently rendered in the grid, in the same order —
// lets the viewer's Prev/Next buttons and arrow-key navigation step
// through whatever result set (or collection) was being browsed when it
// was opened, via openViewer's own entity shape, without an extra fetch
// per step. Same 200-result cap as currentEntityIds above.
let currentEntities = [];

// Every search implicitly scopes to images: this is a photo browser, not
// a general entity browser, so sub-collection Dataset entities never show
// up as tiles in the grid.
let activeFilters = {};

function entityUrl(base, id) {
  return `${base}/${encodeURIComponent(id)}`;
}

async function postEdit(path, body) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? `Request failed: ${response.status}`);
  }
  if (result.errors?.length > 0) {
    throw new Error(result.errors.map((e) => `${e.id}: ${e.message}`).join('; '));
  }
  return result;
}

async function search() {
  statusEl.textContent = 'Loading…';
  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: { ...activeFilters, entityType: IMAGE_ENTITY_TYPE },
        facets: FACET_NAMES,
        limit: 200,
      }),
    });
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }
    const result = await response.json();
    selectedIds = new Set();
    renderFacets(result.facets);
    renderActiveFilters();
    renderGrid(result.entities);
    renderSelectionBar();
    syncCollectionsActiveState();
    syncDatesActiveState();
    syncAlbumsActiveState();
    updateExportAlbumButton();
    statusEl.textContent = `${result.total} image${result.total === 1 ? '' : 's'}`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

function toggleFilter(facetName, value) {
  if (activeFilters[facetName] === value) {
    delete activeFilters[facetName];
  } else {
    activeFilters[facetName] = value;
  }
  search();
}

// Used by a tag clicked inside the full-image viewer: unlike a sidebar
// facet click, the intent here is always "go find more like this", not a
// toggle, so it sets the filter and returns to the (now filtered) grid
// rather than opening back up on the same photo.
function applyFilterAndCloseViewer(facetName, value) {
  activeFilters[facetName] = value;
  closeViewer();
  search();
}

// Shared by the viewer's date breadcrumb and the sidebar's own Dates nav
// (see renderDateNode): narrows to a year, a year+month, or a full
// year+month+day — always replacing whichever of month/day was
// previously active rather than layering on top of it, since clicking
// "2024" after "2024 › 09 › 03" means "show me the whole year", not "the
// whole year, but only September the 3rd". month/day are otherwise
// meaningless without the year they belong to (see buildSearchQuery in
// db/store.js).
function applyDateFilter(year, month, day) {
  activeFilters.year = year;
  if (month) activeFilters.month = month; else delete activeFilters.month;
  if (day) activeFilters.day = day; else delete activeFilters.day;
  search();
}

function applyDateFilterAndCloseViewer(year, month, day) {
  closeViewer();
  applyDateFilter(year, month, day);
}

function renderFacets(facets = {}) {
  facetsEl.innerHTML = '';
  for (const facetName of FACET_NAMES) {
    const values = facets[facetName] ?? [];
    if (values.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'facet-group';

    const heading = document.createElement('h2');
    heading.textContent = labelWithIcon(facetName);
    group.appendChild(heading);

    const valuesEl = document.createElement('div');
    valuesEl.className = 'facet-values';

    for (const { name, count } of values) {
      const row = document.createElement('div');
      row.className = 'facet-value' + (activeFilters[facetName] === name ? ' active' : '');

      const label = document.createElement('span');
      label.textContent = name;
      row.appendChild(label);

      const countEl = document.createElement('span');
      countEl.className = 'count';
      countEl.textContent = count;
      row.appendChild(countEl);

      row.addEventListener('click', () => toggleFilter(facetName, name));
      valuesEl.appendChild(row);
    }

    group.appendChild(valuesEl);
    facetsEl.appendChild(group);
  }
}

function renderActiveFilters() {
  activeFiltersEl.innerHTML = '';
  const entries = Object.entries(activeFilters);
  if (entries.length === 0) return;

  for (const [facetName, value] of entries) {
    const chip = document.createElement('span');
    chip.textContent = `${labelWithIcon(facetName)}: ${value}`;
    const clear = document.createElement('button');
    clear.textContent = '×';
    clear.setAttribute('aria-label', `Clear ${FACET_LABELS[facetName]} filter`);
    clear.addEventListener('click', () => toggleFilter(facetName, value));
    chip.appendChild(clear);
    activeFiltersEl.appendChild(chip);
  }
}

// Groups the flat /ro-crates list into a nested tree by splitting each
// sub-crate's id on '/'. Intermediate segments that aren't themselves a
// registered sub-crate (no ro-crate-metadata.json of their own) become
// plain, unclickable grouping nodes; the root crate ('./') is excluded
// since "All collections" already covers it.
function buildCollectionsTree(roCrates) {
  const root = { children: new Map() };
  for (const crate of roCrates) {
    if (crate.id === './') continue;
    const segments = crate.id.replace(/\/$/, '').split('/');
    let node = root;
    for (const segment of segments) {
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, children: new Map() });
      }
      node = node.children.get(segment);
    }
    node.id = crate.id;
    node.label = crate.name || segments[segments.length - 1];
  }
  return root;
}

function collectionLabelEl(node) {
  if (node.id) {
    const row = document.createElement('button');
    row.className = 'tree-node-button';
    row.textContent = node.label;
    row.dataset.collectionId = node.id;
    row.addEventListener('click', (event) => {
      // Also prevents the native <details>/<summary> toggle from firing
      // when this row is a folder's own clickable label.
      event.preventDefault();
      event.stopPropagation();
      toggleFilter('memberOf', node.id);
    });
    return row;
  }
  const span = document.createElement('span');
  span.className = 'tree-group-label';
  span.textContent = node.name;
  return span;
}

function renderCollectionsNode(node) {
  const ul = document.createElement('ul');
  for (const child of node.children.values()) {
    const li = document.createElement('li');
    if (child.children.size > 0) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.appendChild(collectionLabelEl(child));
      details.appendChild(summary);
      details.appendChild(renderCollectionsNode(child));
      li.appendChild(details);
    } else {
      li.appendChild(collectionLabelEl(child));
    }
    ul.appendChild(li);
  }
  return ul;
}

// Toggles the .active class on whichever collection row (or "All
// collections") matches the current memberOf filter, without touching
// the tree's DOM otherwise — rebuilding it on every search() would
// collapse any folders the user had expanded.
function syncCollectionsActiveState() {
  const activeId = activeFilters.memberOf;
  collectionsAllEl.classList.toggle('active', !activeId);
  collectionsTreeEl.querySelectorAll('.tree-node-button').forEach((row) => {
    row.classList.toggle('active', row.dataset.collectionId === activeId);
  });
}

async function loadCollections() {
  try {
    const response = await fetch('/api/ro-crates');
    if (!response.ok) return;
    const result = await response.json();
    const tree = buildCollectionsTree(result.roCrates ?? []);
    collectionsTreeEl.innerHTML = '';
    collectionsTreeEl.appendChild(renderCollectionsNode(tree));
    syncCollectionsActiveState();
  } catch {
    // Collections nav is a secondary aid; leave the tree empty rather
    // than blocking the rest of the page on this fetch.
  }
}

// The Dates nav — a Year > Month > Day drill-down, each level fetched
// lazily (only once a node is actually expanded) from GET /api/date-facet
// (arocapi/handler.js — kept separate from AROCAPI's own /search facets;
// see facetCounts in db/store.js for why), rather than one request for
// the whole tree: a decades-spanning collection could mean many years
// each with up to 12 months each with up to 31 days, and most of that is
// never actually opened in a given session. A month's own count is a
// natural batch size for "Recognize Faces" (Section 3's Face Recognition
// — batch just means whatever the grid currently shows), which is why
// this goes one level deeper than Collection Folders' own directory
// tree bothers to.
async function fetchDateFacet(granularity, params = {}) {
  const query = new URLSearchParams({ granularity, ...params });
  const response = await fetch(`/api/date-facet?${query}`);
  if (!response.ok) return [];
  return response.json();
}

// Builds one level's <li> row: a clickable button (sets year/year+month/
// year+month+day, replacing whichever of month/day was previously active
// — see applyDateFilter) plus, for year and month nodes, a nested
// <details> that fetches and renders its own children the first time it
// is opened.
function renderDateNode({ value, count, granularity, year, month }) {
  const li = document.createElement('li');
  const isLeaf = granularity === 'day';

  const labelText = `${value} (${count})`;
  const filterValue = () => {
    if (granularity === 'year') applyDateFilter(value, null, null);
    else if (granularity === 'month') applyDateFilter(year, value, null);
    else applyDateFilter(year, month, value);
  };

  if (isLeaf) {
    const button = document.createElement('button');
    button.className = 'tree-node-button';
    button.textContent = labelText;
    button.dataset.dateValue = `${year}-${month}-${value}`;
    button.addEventListener('click', filterValue);
    li.appendChild(button);
    return li;
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const button = document.createElement('button');
  button.className = 'tree-node-button';
  button.textContent = labelText;
  button.dataset.dateValue = granularity === 'year' ? value : `${year}-${value}`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    filterValue();
  });
  summary.appendChild(button);
  details.appendChild(summary);

  const childList = document.createElement('ul');
  details.appendChild(childList);

  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const childGranularity = granularity === 'year' ? 'month' : 'day';
    const childParams = granularity === 'year' ? { year: value } : { year, month: value };
    const children = await fetchDateFacet(childGranularity, childParams);
    for (const child of children) {
      childList.appendChild(renderDateNode({
        value: child.value, count: child.count, granularity: childGranularity,
        year: granularity === 'year' ? value : year,
        month: granularity === 'year' ? undefined : value,
      }));
    }
    syncDatesActiveState();
  });

  li.appendChild(details);
  return li;
}

// Highlights whichever date node exactly matches the current year/month/
// day filter, and re-opens (without re-fetching, since already-loaded
// children stay in the DOM) every ancestor <details> above it, so a
// selection made elsewhere (the viewer's own breadcrumb, "All Dates")
// stays visible in the tree rather than only in the active-filters chip.
function syncDatesActiveState() {
  const { year, month, day } = activeFilters;
  datesAllEl.classList.toggle('active', !year);
  const targetValue = year ? (day ? `${year}-${month}-${day}` : month ? `${year}-${month}` : year) : null;
  datesTreeEl.querySelectorAll('.tree-node-button').forEach((button) => {
    const isActive = targetValue !== null && button.dataset.dateValue === targetValue;
    button.classList.toggle('active', isActive);
    if (isActive) {
      let details = button.closest('li')?.parentElement?.closest('details');
      while (details) {
        details.open = true;
        details = details.parentElement?.closest('details');
      }
    }
  });
}

async function loadDates() {
  try {
    const years = await fetchDateFacet('year');
    datesTreeEl.innerHTML = '';
    const ul = document.createElement('ul');
    for (const { value, count } of years) {
      ul.appendChild(renderDateNode({ value, count, granularity: 'year' }));
    }
    datesTreeEl.appendChild(ul);
    syncDatesActiveState();
  } catch {
    // Dates nav is a secondary aid; leave the tree empty rather than
    // blocking the rest of the page on this fetch.
  }
}

collectionsAllEl.addEventListener('click', () => {
  delete activeFilters.memberOf;
  search();
});

datesAllEl.addEventListener('click', () => {
  delete activeFilters.year;
  delete activeFilters.month;
  delete activeFilters.day;
  search();
});

// Toggles the .active class on whichever album row matches the active
// 'albums' filter — same idea as syncCollectionsActiveState above. This
// is the sidebar's quick-access list of every album (including a brand
// new, still-empty one, which would never appear in the generic facets
// panel below until it has at least one member); selecting one from
// here is otherwise just toggleFilter('albums', name), the exact same
// facet toggle a value in the generic Albums facet group already is —
// the two are two ways to reach one filter, not two different features,
// so both stay in sync with plain activeFilters.albums.
function syncAlbumsActiveState() {
  albumsListEl.querySelectorAll('.album-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.albumName === activeFilters.albums);
  });
}

// The album the top-bar Export Album button currently targets, or null
// when it is hidden — kept as its own variable (rather than re-deriving
// it inside the click handler) since activeFilters.albums, the id it
// resolves to, and what the button is currently wired to send must all
// agree with each other at the moment it is actually clicked.
let exportAlbumTarget = null;

// Shows/hides and relabels the top-bar Export Album button to match
// whichever album is currently selected via the 'albums' filter (see
// syncAlbumsActiveState above — both the sidebar panel and the generic
// Albums facet group set the same activeFilters.albums, so either one
// makes this button appear). Explicit and easy to see on purpose,
// unlike an earlier version of this feature (a small icon button on
// every album row in the sidebar) that turned out to be both too easy
// to click by accident and too small to notice.
function updateExportAlbumButton() {
  const name = activeFilters.albums;
  exportAlbumTarget = name ? [...albumsById.values()].find((album) => album.name === name) ?? null : null;
  exportAlbumButtonEl.classList.toggle('hidden', !exportAlbumTarget);
  if (exportAlbumTarget) {
    exportAlbumButtonEl.textContent = `Export ${exportAlbumTarget.name} Album`;
  }
}

exportAlbumButtonEl.addEventListener('click', async () => {
  if (!exportAlbumTarget) return;
  const { id, name } = exportAlbumTarget;
  exportAlbumButtonEl.disabled = true;
  try {
    const result = await postEdit(`/albums/${encodeURIComponent(id)}/export`, {});
    statusEl.textContent = `Exported ${result.exported} file(s) from "${name}" into ${result.destDir}/`;
  } catch (err) {
    window.alert(`Could not export "${name}": ${err.message}`);
  } finally {
    exportAlbumButtonEl.disabled = false;
  }
});

async function loadAlbumsList() {
  try {
    const response = await fetch('/api/albums');
    if (!response.ok) return;
    const result = await response.json();
    albumsById = new Map((result.albums ?? []).map((album) => [album.id, album]));
    albumsListEl.innerHTML = '';
    for (const album of result.albums ?? []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'album-row';
      row.textContent = album.name;
      row.title = album.description ?? '';
      row.dataset.albumName = album.name;
      row.addEventListener('click', () => toggleFilter('albums', album.name));
      albumsListEl.appendChild(row);
    }
    syncAlbumsActiveState();
    updateExportAlbumButton();
  } catch {
    // Albums nav is a secondary aid; leave the list empty rather than
    // blocking the rest of the page on this fetch.
  }
}

function addViewerTag(facetName, value, container = viewerTagsEl) {
  const tag = document.createElement('button');
  tag.className = 'viewer-tag';
  const icon = FACET_ICONS[facetName];
  tag.textContent = icon ? `${icon} ${value}` : value;
  tag.title = `Filter to ${FACET_LABELS[facetName] ?? facetName}: ${value}`;
  tag.addEventListener('click', () => applyFilterAndCloseViewer(facetName, value));
  container.appendChild(tag);
}

// Re-rendered after a click, with the rating just set, rather than
// relying on the grid's own refresh (search() rebuilds the grid, a
// separate DOM tree the viewer sits outside of and that a click here
// would otherwise leave showing the old rating until the viewer is
// closed and reopened).
function renderViewerRating(rating) {
  viewerRatingEl.innerHTML = '';
  viewerRatingEl.appendChild(renderStarRating(rating, async (newRating) => {
    try {
      await postEdit('/edit/rating', { ids: [currentViewerEntityId], rating: newRating });
      renderViewerRating(newRating);
      await search();
    } catch (err) {
      window.alert(`Could not apply that change: ${err.message}`);
    }
  }));
}

// A clickable "2024 › 09 › 03" in the viewer's top-left corner, built
// from the entity's own dateCreated (ISO 8601, e.g. "2024-09-03T...").
// Each segment applies progressively more of the date as a filter (see
// applyDateFilterAndCloseViewer) — clicking "09" means "everyone in
// September 2024", not just this one photo. Segments are read out of
// fixed string offsets rather than parsed as a Date so that a future
// year-only or year+month-only date (no day, or no month — e.g. from an
// old scanned negative with only an approximate date known) degrades
// gracefully to a shorter breadcrumb instead of showing "NaN" or
// throwing: nothing here assumes every photo has a full date.
function renderViewerBreadcrumb(dateCreated) {
  viewerBreadcrumbEl.innerHTML = '';
  if (!dateCreated || dateCreated.length < 4) return;

  const year = dateCreated.slice(0, 4);
  const month = dateCreated.length >= 7 ? dateCreated.slice(5, 7) : null;
  const day = dateCreated.length >= 10 ? dateCreated.slice(8, 10) : null;

  const segments = [['year', year, () => applyDateFilterAndCloseViewer(year)]];
  if (month) segments.push(['month', month, () => applyDateFilterAndCloseViewer(year, month)]);
  if (day) segments.push(['day', day, () => applyDateFilterAndCloseViewer(year, month, day)]);

  segments.forEach(([key, label, onClick], index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'date-crumb-sep';
      sep.textContent = '›';
      viewerBreadcrumbEl.appendChild(sep);
    }
    const button = document.createElement('button');
    button.textContent = label;
    button.title = `Show every photo from ${key === 'year' ? year : key === 'month' ? `${year}-${month}` : `${year}-${month}-${day}`}`;
    button.addEventListener('click', onClick);
    viewerBreadcrumbEl.appendChild(button);
  });
}

// Camera/lens combined the same way the 'camera'/'lens' facets
// themselves are (see facetValuesFromRecord in db/store.js) — duplicated
// here rather than imported, since webview/app.js cannot import from
// src/core/ (see Spec.md's Face Recognition section for why). Rendered
// as the same clickable facet tags as keywords/people/pets (see
// addViewerTag) — filters the grid to that camera or lens, the same as
// clicking one in the sidebar would. Pixel dimensions have no facet of
// their own to filter by, so that one stays plain text.
function renderViewerMetadata(exifData) {
  viewerMetadataEl.innerHTML = '';
  const exifByName = Object.fromEntries((exifData ?? []).map((entry) => [entry.name, entry.value]));
  const camera = [exifByName.Make, exifByName.Model].filter(Boolean).join(' ');
  const lens = exifByName.LensModel || exifByName.LensMake || '';
  const dimensions = exifByName.ImageWidth && exifByName.ImageHeight ? `${exifByName.ImageWidth}×${exifByName.ImageHeight}` : '';

  if (camera) addViewerTag('camera', camera, viewerMetadataEl);
  if (lens) addViewerTag('lens', lens, viewerMetadataEl);
  if (dimensions) {
    const span = document.createElement('span');
    span.className = 'viewer-metadata-plain';
    span.textContent = dimensions;
    viewerMetadataEl.appendChild(span);
  }
}

// The index of whichever entity the viewer currently shows within
// currentEntities — always looked up fresh (rather than cached) so it
// reflects whatever the grid was last searched to, even if that changed
// since the viewer opened.
function currentViewerIndex() {
  return currentEntities.findIndex((entity) => entity.id === currentViewerEntityId);
}

function updateViewerNavButtons() {
  const index = currentViewerIndex();
  viewerPrevEl.disabled = index <= 0;
  viewerNextEl.disabled = index === -1 || index >= currentEntities.length - 1;
}

// Steps to the next/previous entity in whatever result set (or
// collection) was being browsed when the viewer was opened — the same
// order the grid itself renders in (see renderGrid/currentEntities),
// so Prev/Next and the arrow keys below walk it the same way paging
// through the grid by eye would.
function openViewerAtOffset(delta) {
  const index = currentViewerIndex();
  const nextIndex = index + delta;
  if (index === -1 || nextIndex < 0 || nextIndex >= currentEntities.length) return;
  openViewer(currentEntities[nextIndex]);
}

viewerPrevEl.addEventListener('click', () => openViewerAtOffset(-1));
viewerNextEl.addEventListener('click', () => openViewerAtOffset(1));

document.addEventListener('keydown', (event) => {
  if (!viewerEl.classList.contains('open')) return;
  // Typing a name/keyword into an input elsewhere while the viewer
  // happens to be open should never be hijacked as navigation.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft') openViewerAtOffset(-1);
  else if (event.key === 'ArrowRight') openViewerAtOffset(1);
});

async function openViewer(entity) {
  currentViewerEntityId = entity.id;
  viewerImageEl.src = entityUrl('/api/file', entity.id);
  viewerImageEl.alt = entity.title;
  // entity.title/description/rating all come from the same search result
  // the grid tile itself was rendered from (see entityToJson in the
  // handler), so these can be shown immediately rather than waiting on
  // the metadata fetch below.
  viewerCaptionEl.textContent = entity.title;
  viewerDescriptionEl.textContent = entity.description ?? '';
  renderViewerRating(entity.rating);
  viewerTagsEl.innerHTML = '';
  viewerMetadataEl.innerHTML = '';
  viewerBreadcrumbEl.innerHTML = '';
  currentFaceRegions = [];
  viewerFacesEl.innerHTML = '';
  viewerFacesEl.classList.add('hidden');
  viewerFacesToggleEl.textContent = 'Show faces';
  viewerFacesToggleEl.classList.remove('active');
  viewerFacesToggleEl.disabled = true;
  viewerEl.classList.add('open');
  updateViewerNavButtons();

  // The grid only ever fetches the flat facet columns it needs for
  // search (see search() above); keywords, people/pets, face regions,
  // and the full EXIF list live in the entity's own full RO-Crate
  // document, fetched only once a photo is actually opened.
  try {
    const response = await fetch(entityUrl('/api/entity', entity.id) + '/metadata');
    if (!response.ok) return;
    const metadata = await response.json();

    for (const keyword of metadata.keywords ?? []) {
      addViewerTag('keyword', keyword);
    }
    for (const about of metadata.about ?? []) {
      if (about['@type'] === 'Person') addViewerTag('people', about.name);
      else if (about['@type'] === 'Pet') addViewerTag('pets', about.name);
    }
    renderViewerMetadata(metadata.exifData);
    renderViewerBreadcrumb(unwrapJsonLdValue(metadata.dateCreated));

    // A pet is tagged the same way as a person (Type: "Pet" rather than
    // "Face" — MWG has no separate "animal face" region type), so it
    // belongs in the same overlay. A region has a drawable box either
    // way it was recorded — the legacy xPosition/etc. shape, or a
    // standoff region's oa:hasTarget fragment (see regionBox below).
    currentFaceRegions = (metadata.regions ?? []).filter(
      (region) => (region.regionType === 'Face' || region.regionType === 'Pet') && (region.xPosition !== undefined || region['oa:hasTarget'] !== undefined),
    );
    viewerFacesToggleEl.disabled = currentFaceRegions.length === 0;
  } catch {
    // No metadata to show is not fatal: the image itself still displays.
  }
}

function closeViewer() {
  viewerEl.classList.remove('open');
  viewerImageEl.src = '';
  currentViewerEntityId = null;
}

// A region's drawable box, as a top-left fraction (0-1) of the full
// image, regardless of which of the two shapes it was recorded in (see
// Spec.md's Face Recognition section): the legacy xPosition/yPosition/
// width/height (MWG's own centre-based convention), or a standoff
// region's oa:hasTarget — a Media Fragments URI fragment,
// `#xywh=percent:x,y,w,h`, already top-left (see addStandoffFaceRegion
// in crateBuilder.js, which this mirrors — webview/app.js cannot import
// from src/core/, see Spec.md's Face Recognition section for why).
// Returns null if neither shape is recognised.
function regionBox(region) {
  if (region.xPosition !== undefined) {
    const x = unwrapJsonLdValue(region.xPosition);
    const y = unwrapJsonLdValue(region.yPosition);
    const width = unwrapJsonLdValue(region.width);
    const height = unwrapJsonLdValue(region.height);
    return { left: x - width / 2, top: y - height / 2, width, height };
  }
  const targetId = unwrapJsonLdValue(region['oa:hasTarget'])?.['@id'];
  const marker = '#xywh=percent:';
  const markerIndex = targetId?.lastIndexOf(marker) ?? -1;
  if (markerIndex === -1) return null;
  const parts = targetId.slice(markerIndex + marker.length).split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  const [x, y, width, height] = parts;
  return { left: x / 100, top: y / 100, width: width / 100, height: height / 100 };
}

function renderFaceOverlay() {
  viewerFacesEl.innerHTML = '';
  const { naturalWidth, naturalHeight, clientWidth, clientHeight } = viewerImageEl;
  if (!naturalWidth || !naturalHeight) return;

  // object-fit: contain centers the image within its box, adding
  // letterboxing on one axis when the aspect ratios differ — boxes are
  // positioned against that actual rendered image rect, not the
  // (possibly larger) element box.
  const scale = Math.min(clientWidth / naturalWidth, clientHeight / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  const offsetX = (clientWidth - renderedWidth) / 2;
  const offsetY = (clientHeight - renderedHeight) / 2;

  for (const region of currentFaceRegions) {
    const regionBoxFraction = regionBox(region);
    if (!regionBoxFraction) continue;

    const box = document.createElement('div');
    box.className = 'face-box';
    box.style.left = `${offsetX + regionBoxFraction.left * renderedWidth}px`;
    box.style.top = `${offsetY + regionBoxFraction.top * renderedHeight}px`;
    box.style.width = `${regionBoxFraction.width * renderedWidth}px`;
    box.style.height = `${regionBoxFraction.height * renderedHeight}px`;

    const label = document.createElement('span');
    label.className = 'face-box-label';
    label.textContent = region.name;
    box.appendChild(label);

    viewerFacesEl.appendChild(box);
  }
}

viewerFacesToggleEl.addEventListener('click', () => {
  const showing = viewerFacesEl.classList.toggle('hidden') === false;
  viewerFacesToggleEl.classList.toggle('active', showing);
  viewerFacesToggleEl.textContent = showing ? 'Hide faces' : 'Show faces';
  if (showing) renderFaceOverlay();
});

viewerImageEl.addEventListener('load', () => {
  if (!viewerFacesEl.classList.contains('hidden')) renderFaceOverlay();
});

window.addEventListener('resize', () => {
  if (viewerEl.classList.contains('open') && !viewerFacesEl.classList.contains('hidden')) renderFaceOverlay();
});

/**
 * A row of five stars — outline for any position above the current
 * rating, filled at and below it — for both the grid's per-tile rating
 * and the viewer's own. Clicking a star sets the rating to its position,
 * except clicking the star that already matches the current rating,
 * which clears it instead (so there is a way to remove a rating without
 * a separate control).
 *
 * @param {number|null} rating
 * @param {(newRating: number|null) => void} onRate
 * @returns {HTMLElement}
 */
function renderStarRating(rating, onRate) {
  const row = document.createElement('div');
  row.className = 'star-rating';
  for (let position = 1; position <= 5; position++) {
    const filled = rating !== null && position <= rating;
    const star = document.createElement('button');
    star.type = 'button';
    star.className = filled ? 'filled' : 'empty';
    star.textContent = filled ? '★' : '☆';
    star.setAttribute('aria-label', `Rate ${position} star${position === 1 ? '' : 's'}`);
    star.addEventListener('click', (event) => {
      // Also relevant in the grid, where a tile's own click opens the
      // viewer — a star click should only ever set the rating.
      event.stopPropagation();
      onRate(rating === position ? null : position);
    });
    row.appendChild(star);
  }
  return row;
}

function renderGrid(entities) {
  gridEl.innerHTML = '';
  currentEntityIds = entities.map((entity) => entity.id);
  currentEntities = entities;
  for (const entity of entities) {
    const figure = document.createElement('figure');

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'select-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(entity.id);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(entity.id);
      else selectedIds.delete(entity.id);
      renderSelectionBar();
    });
    checkboxLabel.appendChild(checkbox);
    figure.appendChild(checkboxLabel);

    const img = document.createElement('img');
    img.src = entityUrl('/api/entity', entity.id) + '/thumbnail';
    img.alt = entity.title;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      // No thumbnail available (see the handler's /entity/{id}/thumbnail
      // route) — fall back to the full-size image rather than a broken
      // image icon.
      img.src = entityUrl('/api/file', entity.id);
    });
    figure.appendChild(img);

    figure.appendChild(renderStarRating(entity.rating, (newRating) => {
      runEditAction(() => postEdit('/edit/rating', { ids: [entity.id], rating: newRating }));
    }));

    const caption = document.createElement('figcaption');
    caption.textContent = entity.title;
    figure.appendChild(caption);

    figure.addEventListener('click', () => openViewer(entity));
    gridEl.appendChild(figure);
  }
}

function renderSelectionBar() {
  selectionBarEl.classList.toggle('visible', selectedIds.size > 0);
  selectionCountEl.textContent = `${selectedIds.size} selected`;
}

function promptKeyword(actionLabel, description) {
  const keyword = window.prompt(`${actionLabel} for ${description}:`);
  return keyword?.trim() || null;
}

// The keywords added so far in the currently-open dialog (via the (+)
// button, Enter, or clicking a suggestion), separate from whatever is
// still sitting, uncommitted, in the text input.
let pendingKeywords = [];

// Every keyword already used anywhere in the collection, fetched fresh
// each time the dialog opens (see promptKeywords) from the same facet
// data the sidebar's Keywords list already uses — POST /search with
// facets: ['keyword'] and no filters returns the whole vocabulary in one
// cheap call, so no dedicated autocomplete endpoint is needed for a
// collection this size. Drives both the native datalist dropdown on the
// input and the always-visible, click-to-add suggestion list below it.
let knownKeywords = [];

async function fetchKnownKeywords() {
  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, facets: ['keyword'], limit: 0 }),
    });
    if (!response.ok) return [];
    const result = await response.json();
    return (result.facets?.keyword ?? []).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function renderKeywordChips() {
  keywordChipListEl.innerHTML = '';
  for (const keyword of pendingKeywords) {
    const chip = document.createElement('span');
    chip.className = 'keyword-chip';
    chip.textContent = keyword;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove "${keyword}"`);
    remove.addEventListener('click', () => {
      pendingKeywords = pendingKeywords.filter((k) => k !== keyword);
      renderKeywordChips();
      renderKeywordSuggestions();
    });
    chip.appendChild(remove);

    keywordChipListEl.appendChild(chip);
  }
}

function renderKeywordSuggestions() {
  keywordSuggestionsListEl.innerHTML = '';
  const typed = keywordInputEl.value.trim().toLowerCase();
  const matches = knownKeywords.filter(
    (keyword) => !pendingKeywords.includes(keyword) && (!typed || keyword.toLowerCase().includes(typed)),
  );

  for (const keyword of matches) {
    const suggestion = document.createElement('button');
    suggestion.type = 'button';
    suggestion.className = 'keyword-suggestion';
    suggestion.textContent = keyword;
    suggestion.addEventListener('click', () => addPendingKeyword(keyword));
    keywordSuggestionsListEl.appendChild(suggestion);
  }
}

function addPendingKeyword(value) {
  if (!value || pendingKeywords.includes(value)) return;
  pendingKeywords = [...pendingKeywords, value];
  renderKeywordChips();
  renderKeywordSuggestions();
}

function addPendingKeywordFromInput() {
  const value = keywordInputEl.value.trim();
  keywordInputEl.value = '';
  keywordInputEl.focus();
  addPendingKeyword(value);
}

document.querySelector('#keyword-add-button').addEventListener('click', addPendingKeywordFromInput);
keywordInputEl.addEventListener('input', renderKeywordSuggestions);
keywordInputEl.addEventListener('keydown', (event) => {
  // Enter adds the typed keyword to the list rather than submitting the
  // dialog — matching the (+) button, so a keyboard-only user is not
  // stuck with one keyword at a time either.
  if (event.key === 'Enter') {
    event.preventDefault();
    addPendingKeywordFromInput();
  }
});

document.querySelector('#keyword-dialog-cancel').addEventListener('click', () => {
  keywordDialogEl.close('cancel');
});

let keywordDialogResolve = null;

keywordDialogEl.addEventListener('close', () => {
  if (keywordDialogEl.returnValue !== 'submit') {
    keywordDialogResolve?.(null);
    keywordDialogResolve = null;
    return;
  }
  // Whatever is still sitting in the input, not yet added via (+), is
  // included as a courtesy — typing one keyword and hitting "Add"
  // directly is a very plausible single-keyword flow, and it would be
  // surprising for that to silently do nothing.
  const trailing = keywordInputEl.value.trim();
  const keywords = trailing && !pendingKeywords.includes(trailing) ? [...pendingKeywords, trailing] : pendingKeywords;
  keywordDialogResolve?.(keywords);
  keywordDialogResolve = null;
});

/**
 * Opens the multi-keyword entry dialog and resolves with the list of
 * keywords entered (each added via the (+) button, Enter, or left in the
 * input when submitted), or null if cancelled. An empty list (submitted
 * with nothing entered) is possible and is left for the caller to treat
 * as "nothing to do".
 *
 * @param {string} description - e.g. "3 image(s)" or "this image"
 * @returns {Promise<string[]|null>}
 */
function promptKeywords(description) {
  return new Promise((resolve) => {
    keywordDialogResolve = resolve;
    keywordDialogDescriptionEl.textContent = `Add keyword(s) for ${description}:`;
    keywordInputEl.value = '';
    pendingKeywords = [];
    knownKeywords = [];
    keywordDatalistEl.innerHTML = '';
    renderKeywordChips();
    renderKeywordSuggestions();
    // Opened immediately rather than waiting on the fetch below, so
    // there is no perceptible delay before the dialog appears; the
    // suggestion list and datalist just fill in a moment after.
    keywordDialogEl.showModal();
    keywordInputEl.focus();

    fetchKnownKeywords().then((keywords) => {
      knownKeywords = keywords;
      for (const keyword of keywords) {
        const option = document.createElement('option');
        option.value = keyword;
        keywordDatalistEl.appendChild(option);
      }
      renderKeywordSuggestions();
    });
  });
}

// A single-value counterpart to the keyword dialog above, for naming or
// reassigning a face (see the Face Recognition review screen): the same
// lookup — a native datalist dropdown plus an always-visible, click-to-
// fill suggestion list narrowing as you type — but resolving with one
// name rather than building up a list, since a face belongs to exactly
// one person.
let knownPeople = [];

async function fetchKnownPeople() {
  try {
    const response = await fetch(`/api/entities?entityType=${encodeURIComponent('http://schema.org/Person')}`);
    if (!response.ok) return [];
    const result = await response.json();
    return result.entities.map((entity) => entity.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function renderPersonSuggestions() {
  personSuggestionsListEl.innerHTML = '';
  const typed = personInputEl.value.trim().toLowerCase();
  const matches = knownPeople.filter((name) => !typed || name.toLowerCase().includes(typed));

  for (const name of matches) {
    const suggestion = document.createElement('button');
    suggestion.type = 'button';
    suggestion.className = 'keyword-suggestion';
    suggestion.textContent = name;
    suggestion.addEventListener('click', () => {
      personInputEl.value = name;
      personInputEl.focus();
    });
    personSuggestionsListEl.appendChild(suggestion);
  }
}

personInputEl.addEventListener('input', renderPersonSuggestions);

document.querySelector('#person-dialog-cancel').addEventListener('click', () => {
  personDialogEl.close('cancel');
});

let personDialogResolve = null;

personDialogEl.addEventListener('close', () => {
  if (personDialogEl.returnValue !== 'submit') {
    personDialogResolve?.(null);
    personDialogResolve = null;
    return;
  }
  const name = personInputEl.value.trim();
  personDialogResolve?.(name || null);
  personDialogResolve = null;
});

/**
 * Opens the single-name lookup dialog and resolves with the name
 * entered (typed fresh, or picked from a suggestion), or null if
 * cancelled or submitted blank.
 *
 * @param {string} description - e.g. "Who is this?"
 * @param {string} [currentValue] - pre-filled, e.g. an existing suggestion being corrected
 * @returns {Promise<string|null>}
 */
function promptPersonName(description, currentValue = '') {
  return new Promise((resolve) => {
    personDialogResolve = resolve;
    personDialogDescriptionEl.textContent = description;
    personInputEl.value = currentValue;
    knownPeople = [];
    personDatalistEl.innerHTML = '';
    renderPersonSuggestions();
    personDialogEl.showModal();
    personInputEl.focus();
    personInputEl.select();

    fetchKnownPeople().then((people) => {
      knownPeople = people;
      for (const name of people) {
        const option = document.createElement('option');
        option.value = name;
        personDatalistEl.appendChild(option);
      }
      renderPersonSuggestions();
    });
  });
}

// Albums (Section 3's Albums): a "New Album" dialog for creating one
// (name + optional description), and a separate picker for "Add to
// album" that only ever chooses among existing albums — matching the
// spec's own "build one at a time" split between creating an album and
// adding images to it.

document.querySelector('#new-album-dialog-cancel').addEventListener('click', () => {
  newAlbumDialogEl.close('cancel');
});

let newAlbumDialogResolve = null;

newAlbumDialogEl.addEventListener('close', () => {
  if (newAlbumDialogEl.returnValue !== 'submit') {
    newAlbumDialogResolve?.(null);
    newAlbumDialogResolve = null;
    return;
  }
  const name = newAlbumNameEl.value.trim();
  newAlbumDialogResolve?.(name ? { name, description: newAlbumDescriptionEl.value.trim() || null } : null);
  newAlbumDialogResolve = null;
});

/**
 * Opens the "New Album" dialog and resolves with {name, description}, or
 * null if cancelled or submitted with a blank name.
 *
 * @returns {Promise<{name: string, description: string|null}|null>}
 */
function promptNewAlbum() {
  return new Promise((resolve) => {
    newAlbumDialogResolve = resolve;
    newAlbumNameEl.value = '';
    newAlbumDescriptionEl.value = '';
    newAlbumDialogEl.showModal();
    newAlbumNameEl.focus();
  });
}

// Every album, most-recently-used first (see listAlbums in db/store.js) —
// fetched once when the picker opens and then filtered client-side as
// the search box narrows it, the same "fetch the whole small vocabulary
// once" approach the keyword dialog's suggestion list already uses,
// rather than a network round trip per keystroke.
let knownAlbums = [];

async function fetchAlbums() {
  try {
    const response = await fetch('/api/albums');
    if (!response.ok) return [];
    const result = await response.json();
    return result.albums ?? [];
  } catch {
    return [];
  }
}

function renderAlbumPickerOptions() {
  albumPickerListEl.innerHTML = '';
  const typed = albumPickerInputEl.value.trim().toLowerCase();
  // With nothing typed, only the 3 most recently used are shown (the
  // quick-access list the spec calls for); typing narrows across every
  // album, not just those 3.
  const matches = typed
    ? knownAlbums.filter((album) => album.name.toLowerCase().includes(typed))
    : knownAlbums.slice(0, 3);

  for (const album of matches) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'album-picker-option';
    const name = document.createElement('span');
    name.className = 'album-picker-option-name';
    name.textContent = album.name;
    option.appendChild(name);
    if (album.description) {
      const description = document.createElement('span');
      description.className = 'album-picker-option-description';
      description.textContent = album.description;
      option.appendChild(description);
    }
    // Picking an album is the whole action — unlike the keyword/person
    // suggestion lists, which only fill the input for further editing,
    // there is nothing left to refine once an album is chosen.
    option.addEventListener('click', () => {
      albumPickerDialogEl.returnValue = 'submit';
      albumPickerResolve?.(album);
      albumPickerResolve = null;
      albumPickerDialogEl.close();
    });
    albumPickerListEl.appendChild(option);
  }
}

albumPickerInputEl.addEventListener('input', renderAlbumPickerOptions);

document.querySelector('#album-picker-cancel').addEventListener('click', () => {
  albumPickerDialogEl.close('cancel');
});

let albumPickerResolve = null;

albumPickerDialogEl.addEventListener('close', () => {
  // A picked album already resolved and cleared albumPickerResolve
  // itself (see renderAlbumPickerOptions) before calling close(); this
  // only handles Cancel or a dismissal (Escape key).
  albumPickerResolve?.(null);
  albumPickerResolve = null;
});

/**
 * Opens the "Add to album" picker and resolves with the chosen album
 * ({id, name, description}), or null if cancelled.
 *
 * @param {string} description - e.g. "Add 3 image(s) to album:"
 * @returns {Promise<{id: string, name: string, description: string|null}|null>}
 */
function promptAlbumPicker(description) {
  return new Promise((resolve) => {
    albumPickerResolve = resolve;
    albumPickerDescriptionEl.textContent = description;
    albumPickerInputEl.value = '';
    knownAlbums = [];
    renderAlbumPickerOptions();
    albumPickerDialogEl.showModal();
    albumPickerInputEl.focus();

    fetchAlbums().then((albums) => {
      knownAlbums = albums;
      renderAlbumPickerOptions();
    });
  });
}

document.querySelector('#new-album-button').addEventListener('click', async () => {
  const album = await promptNewAlbum();
  if (!album) return;
  try {
    await postEdit('/albums', album);
    statusEl.textContent = `Created album "${album.name}".`;
    await loadAlbumsList();
  } catch (err) {
    window.alert(`Could not create the album: ${err.message}`);
  }
});

document.querySelector('#selection-add-to-album').addEventListener('click', async () => {
  const album = await promptAlbumPicker(`Add ${selectedIds.size} image(s) to album:`);
  if (!album) return;
  try {
    await postEdit(`/albums/${encodeURIComponent(album.id)}/add`, { imageIds: [...selectedIds] });
    statusEl.textContent = `Added ${selectedIds.size} image(s) to "${album.name}".`;
    // Bumps the album to the top of the sidebar list, matching its new
    // "most recently used" position (see touchAlbum in db/store.js).
    await loadAlbumsList();
  } catch (err) {
    window.alert(`Could not add to that album: ${err.message}`);
  }
});

function promptRating(description) {
  const input = window.prompt(`Set rating (1-5, or leave blank to clear) for ${description}:`);
  if (input === null) return undefined; // cancelled
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const rating = Number(trimmed);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    window.alert('Rating must be a whole number from 1 to 5, or left blank to clear it.');
    return undefined;
  }
  return rating;
}

async function runEditAction(action) {
  try {
    await action();
    await search();
  } catch (err) {
    window.alert(`Could not apply that change: ${err.message}`);
  }
}

selectAllButtonEl.addEventListener('click', () => {
  selectedIds = new Set(currentEntityIds);
  gridEl.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.checked = true; });
  renderSelectionBar();
});

document.querySelector('#selection-clear').addEventListener('click', () => {
  selectedIds = new Set();
  gridEl.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.checked = false; });
  renderSelectionBar();
});

document.querySelector('#selection-add-keyword').addEventListener('click', async () => {
  const keywords = await promptKeywords(`${selectedIds.size} image(s)`);
  if (!keywords || keywords.length === 0) return;
  runEditAction(() => postEdit('/edit/keywords', { ids: [...selectedIds], add: keywords }));
});

document.querySelector('#selection-remove-keyword').addEventListener('click', () => {
  const keyword = promptKeyword('Remove keyword', `${selectedIds.size} image(s)`);
  if (!keyword) return;
  runEditAction(() => postEdit('/edit/keywords', { ids: [...selectedIds], remove: [keyword] }));
});

document.querySelector('#selection-set-rating').addEventListener('click', () => {
  const rating = promptRating(`${selectedIds.size} image(s)`);
  if (rating === undefined) return;
  runEditAction(() => postEdit('/edit/rating', { ids: [...selectedIds], rating }));
});

document.querySelector('#selection-delete').addEventListener('click', () => {
  if (!window.confirm(`Delete ${selectedIds.size} image(s)? They will be moved to _rocphotos/trash, not permanently deleted.`)) return;
  runEditAction(() => postEdit('/edit/delete', { ids: [...selectedIds] }));
});

document.querySelector('#viewer-close').addEventListener('click', closeViewer);
viewerEl.addEventListener('click', (event) => {
  if (event.target === viewerEl) closeViewer();
});

document.querySelector('#viewer-add-keyword').addEventListener('click', async () => {
  const keywords = await promptKeywords('this image');
  if (!keywords || keywords.length === 0) return;
  try {
    await postEdit('/edit/keywords', { ids: [currentViewerEntityId], add: keywords });
    // Added directly to the still-open viewer's own tag list — search()
    // below refreshes the grid, a separate DOM tree the viewer sits
    // outside of, so without this the newly-added tag would not show up
    // here until the viewer was closed and reopened.
    for (const keyword of keywords) {
      addViewerTag('keyword', keyword);
    }
    await search();
  } catch (err) {
    window.alert(`Could not apply that change: ${err.message}`);
  }
});

document.querySelector('#viewer-edit-title').addEventListener('click', async () => {
  const title = window.prompt('Title for this image (leave blank to reset to its filename):', viewerCaptionEl.textContent);
  if (title === null) return; // cancelled
  try {
    await postEdit('/edit/title', { ids: [currentViewerEntityId], title });
    // Set directly on the still-open viewer, same reason as the keyword
    // and rating handlers above: search() below only refreshes the grid.
    // Read back via a fresh metadata fetch rather than trusting `title`
    // directly, since an empty title resolves to the filename server-side
    // (see setImageTitle), not to a blank caption.
    const response = await fetch(entityUrl('/api/entity', currentViewerEntityId) + '/metadata');
    const metadata = await response.json();
    viewerCaptionEl.textContent = metadata.title?.[0] ?? viewerCaptionEl.textContent;
    await search();
  } catch (err) {
    window.alert(`Could not apply that change: ${err.message}`);
  }
});

document.querySelector('#viewer-edit-description').addEventListener('click', async () => {
  const description = window.prompt('Description for this image (leave blank to clear it):', viewerDescriptionEl.textContent);
  if (description === null) return; // cancelled
  try {
    await postEdit('/edit/description', { ids: [currentViewerEntityId], description });
    viewerDescriptionEl.textContent = description.trim();
    await search();
  } catch (err) {
    window.alert(`Could not apply that change: ${err.message}`);
  }
});

document.querySelector('#viewer-delete').addEventListener('click', () => {
  if (!window.confirm('Delete this image? It will be moved to _rocphotos/trash, not permanently deleted.')) return;
  // Captured before closeViewer() runs, since that resets
  // currentViewerEntityId to null.
  const idToDelete = currentViewerEntityId;
  closeViewer();
  runEditAction(() => postEdit('/edit/delete', { ids: [idToDelete] }));
});

// --- Face recognition (see Spec.md's Face Recognition section) ---
//
// Detection and embedding both run entirely client-side, via face-api.js
// (webview/vendor/, loaded as a plain script — see index.html — so the
// same code works whether app.js itself is served by the CLI's static
// file server or bundled by Vite). Only matching against the reference
// set, and storing pending detections for review, happen server-side
// (POST /api/faces/detections) — see src/core/faces/handler.js.
const FACE_MODEL_NAME = 'face-api.js';
const FACE_MODEL_VERSION = '0.22.2';
const FACE_MODELS_URL = 'vendor/models';

let faceApiModelsLoaded = false;
async function ensureFaceApiModelsLoaded() {
  if (faceApiModelsLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromUri(FACE_MODELS_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
  faceApiModelsLoaded = true;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

// Runs face-api.js against one image's full-size bytes, returning each
// detected face as a fractional (0-1) top-left box plus its 128-d
// descriptor — face-api.js's own box is in pixels, converted here so it
// matches the fractional convention used everywhere else in this app
// (see Spec.md's ImageRegion notes).
async function detectFacesForImage(imageId) {
  const img = await loadImage(entityUrl('/api/file', imageId));
  const results = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
  return results.map((result) => ({
    box: {
      x: result.detection.box.x / img.naturalWidth,
      y: result.detection.box.y / img.naturalHeight,
      w: result.detection.box.width / img.naturalWidth,
      h: result.detection.box.height / img.naturalHeight,
    },
    embedding: Array.from(result.descriptor),
  }));
}

// Computes an embedding for a region already tagged by another tool (or
// confirmed in an earlier session), so the reference set is not limited
// to faces confirmed through this app's own review screen — otherwise a
// person tagged throughout a whole collection would never be suggested
// on the very first run, since the reference set starts empty. `area` is
// MWG's own center-point convention (x/y at the box's center — see
// Spec.md), unlike face-api.js's own top-left box used elsewhere here;
// converted below, then padded generously and cropped before detecting,
// since a tight, exact face box is not always reliably re-detected on
// its own.
// Duplicated from src/core/faces/geometry.js (webview/app.js cannot
// import from src/core — see the note above FACE_MODEL_NAME/VERSION):
// converts an MWG region's center-based Area to the fractional top-left
// shape face-api.js's own detection box uses, and a "same face?" measure
// for two such boxes. Keep in sync with that file if either changes.
function centerAreaToTopLeftBox(area) {
  return { x: area.x - area.w / 2, y: area.y - area.h / 2, w: area.w, h: area.h };
}

// Overlap relative to the SMALLER of the two boxes, not their union —
// needed because different tools draw a face box at genuinely different
// scales for the same face (a tight box around facial features vs. one
// including more of the head), not just a different position; plain
// intersection-over-union penalises that scale difference so heavily
// that a real match can score well under any reasonable threshold. See
// src/core/faces/geometry.js's containmentOverlapRatio for the real
// numbers that confirmed this.
function containmentOverlapRatio(boxA, boxB) {
  const ix1 = Math.max(boxA.x, boxB.x);
  const iy1 = Math.max(boxA.y, boxB.y);
  const ix2 = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
  const iy2 = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  if (intersection === 0) return 0;
  const smallerArea = Math.min(boxA.w * boxA.h, boxB.w * boxB.h);
  return intersection / smallerArea;
}

const SAME_FACE_OVERLAP_THRESHOLD = 0.3;

// Finds this region's embedding by running full-image detection — the
// same reliable method already used for finding new faces — rather than
// cropping a small, padded area around the tagged box and hoping
// detectSingleFace finds something in it: confirmed against a real
// collection that the crop approach silently failed for the large
// majority of already-tagged faces (a face that is small relative to a
// generous crop, or cut off by a tight one, often goes undetected).
// Tries both the raw and orientation-corrected form of the region's
// Area, since different tagging tools disagree about which frame Area
// is measured against for the same Orientation value — confirmed
// against two real files, one needing the correction, one broken by it.
// Falls back to a generously-padded, tightly zoomed crop around a known
// region, at a much lower confidence threshold than normal detection
// ever uses — confirmed empirically (see Spec.md's Face Recognition
// section) against a real, small background face in a group photo that
// full-image detection missed outright, since face-api.js downscales
// the whole image internally, and a small face can end up too tiny to
// recognize (or score below the default 0.5 confidence cutoff even when
// it is technically found). A low threshold is safe only because a
// human already confirmed a face is exactly here — there is nothing
// else inside a crop this tight to misattribute a detection to.
async function detectInCrop(img, area) {
  const centerX = area.x * img.naturalWidth;
  const centerY = area.y * img.naturalHeight;
  const boxW = area.w * img.naturalWidth;
  const boxH = area.h * img.naturalHeight;
  const pad = 1.5;
  const sx = Math.max(0, centerX - (boxW * (1 + pad)) / 2);
  const sy = Math.max(0, centerY - (boxH * (1 + pad)) / 2);
  const sw = Math.min(img.naturalWidth - sx, boxW * (1 + pad));
  const sh = Math.min(img.naturalHeight - sy, boxH * (1 + pad));
  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const result = await faceapi
    .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.1 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return result ? Array.from(result.descriptor) : null;
}

async function computeEmbeddingForKnownRegion(imageId, rawArea, correctedArea) {
  const img = await loadImage(entityUrl('/api/file', imageId));

  // Whole-image detection first, at the normal confidence threshold:
  // reliable for an ordinary-sized face, and — since it is matched by
  // position against the known region, the same as /detections' own
  // duplicate check — never at risk of confusing this region with a
  // different nearby face the way a crop alone could.
  const results = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
  const rawBox = centerAreaToTopLeftBox(rawArea);
  const correctedBox = centerAreaToTopLeftBox(correctedArea);
  let best = null;
  for (const result of results) {
    const box = {
      x: result.detection.box.x / img.naturalWidth,
      y: result.detection.box.y / img.naturalHeight,
      w: result.detection.box.width / img.naturalWidth,
      h: result.detection.box.height / img.naturalHeight,
    };
    const overlap = Math.max(containmentOverlapRatio(box, rawBox), containmentOverlapRatio(box, correctedBox));
    if (!best || overlap > best.overlap) best = { overlap, descriptor: result.descriptor };
  }
  if (best && best.overlap >= SAME_FACE_OVERLAP_THRESHOLD) return Array.from(best.descriptor);

  return (await detectInCrop(img, rawArea)) ?? (await detectInCrop(img, correctedArea));
}

// Every image id in the whole collection, regardless of the current
// filters/selection — used to scope the backfill step below (see
// recognizeFacesButtonEl's click handler): learning from an existing tag
// is a one-time, collection-wide bit of bookkeeping, not something that
// should depend on which directory happens to be open when "Recognize
// Faces" is clicked, unlike finding new faces, which is deliberately
// scoped to the current view. Already-backfilled regions are skipped
// server-side (see hasReferenceForPersonOnImage), so repeating this
// full-collection check on every click never re-adds a duplicate — it
// does still re-read and re-check every image's crate each time, though,
// which is real (if currently unavoidable) repeated work, not just a
// cheap no-op; see Spec.md's Face Recognition section.
async function fetchAllImageIds() {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { entityType: IMAGE_ENTITY_TYPE }, facets: [], limit: 100000 }),
  });
  if (!response.ok) throw new Error(`Could not list the collection's images: ${response.status}`);
  const result = await response.json();
  return result.entities.map((entity) => entity.id);
}

// Backfills reference embeddings for every already-tagged region across
// the given images that does not have one yet (see
// computeEmbeddingForKnownRegion), before looking for any new faces —
// otherwise recognition would have nothing to match against even for
// someone tagged throughout the whole collection. Returns how many
// regions could not be matched even after a genuine attempt (a whole-
// image detection pass plus the zoomed, low-confidence crop fallback) —
// these are reported to /faces/backfill-undetectable so the server stops
// re-examining their image on every future run (see Spec.md's Face
// Recognition section) rather than retrying forever, and the count is
// surfaced in the final status message so this is never a silent giveup.
async function backfillExistingRegions(imageIds) {
  const { regions } = await postEdit('/faces/existing-regions', {
    imageIds, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
  });
  let undetectableCount = 0;
  for (let i = 0; i < regions.length; i += 1) {
    statusEl.textContent = `Learning known faces… (${i + 1}/${regions.length})`;
    const region = regions[i];
    const embedding = await computeEmbeddingForKnownRegion(region.imageId, region.rawArea, region.correctedArea).catch(() => null);
    if (!embedding) {
      // Not reliably re-detectable from its own tagged box even with the
      // crop fallback — a real, one-time attempt was made, so this is
      // reported as given up rather than silently skipped (see
      // /faces/backfill-undetectable).
      undetectableCount += 1;
      await postEdit('/faces/backfill-undetectable', {
        sourceImageId: region.imageId, personName: region.personName,
        modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
      });
      continue;
    }
    await postEdit('/faces/backfill-reference', {
      sourceImageId: region.imageId, sourceRegionId: region.sourceRegionId, personName: region.personName,
      embedding, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
    });
  }
  return undetectableCount;
}

recognizeFacesButtonEl.addEventListener('click', async () => {
  if (currentEntityIds.length === 0) {
    window.alert('No images in the current view to scan.');
    return;
  }
  recognizeFacesButtonEl.disabled = true;
  try {
    statusEl.textContent = 'Loading face recognition models…';
    await ensureFaceApiModelsLoaded();

    statusEl.textContent = 'Checking for already-tagged faces across the whole collection…';
    const undetectableCount = await backfillExistingRegions(await fetchAllImageIds());

    const { toScan } = await postEdit('/faces/scan-status', {
      imageIds: currentEntityIds, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
    });

    for (let i = 0; i < toScan.length; i += 1) {
      statusEl.textContent = `Finding faces… (${i + 1}/${toScan.length})`;
      const faces = await detectFacesForImage(toScan[i]);
      await postEdit('/faces/detections', { imageId: toScan[i], modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION, faces });
    }

    const undetectableNote = undetectableCount > 0
      ? ` (${undetectableCount} already-tagged face${undetectableCount === 1 ? '' : 's'} could not be re-matched automatically — see Spec.md)`
      : '';
    statusEl.textContent = `${currentEntityIds.length} image${currentEntityIds.length === 1 ? '' : 's'}${undetectableNote}`;
    await openFacesReview();
  } catch (err) {
    window.alert(`Could not run face recognition: ${err.message}`);
  } finally {
    recognizeFacesButtonEl.disabled = false;
  }
});

// Draws a detection's face, cropped from its full source image, into a
// small canvas — done on demand for the review screen rather than
// reusing whatever was decoded during detection, which may belong to an
// entirely separate session (the review screen can be reopened any time
// there are pending detections, not only right after a scan).
async function drawFaceCrop(canvas, detection) {
  const img = await loadImage(entityUrl('/api/file', detection.imageId));
  const sx = detection.box.x * img.naturalWidth;
  const sy = detection.box.y * img.naturalHeight;
  const sw = detection.box.w * img.naturalWidth;
  const sh = detection.box.h * img.naturalHeight;
  canvas.width = 200;
  canvas.height = Math.max(1, Math.round((200 * sh) / sw));
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

async function resolveDetection(detectionId, path, body) {
  try {
    await postEdit(path, { detectionId, ...body });
    await openFacesReview();
  } catch (err) {
    window.alert(`Could not apply that change: ${err.message}`);
  }
}

// For a detection with no suggestion: naming it (via the lookup dialog),
// ignoring it, or ignoring it as a permanent stranger. A suggested match
// is never rendered this way — see renderMatchGroup below, which groups
// those together for batch approval instead.
function renderFaceCard(detection) {
  const card = document.createElement('div');
  card.className = 'face-card';

  const canvas = document.createElement('canvas');
  card.appendChild(canvas);
  drawFaceCrop(canvas, detection).catch(() => {});

  const label = document.createElement('div');
  label.className = 'face-card-label';
  label.textContent = detection.imageTitle;
  card.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'face-card-actions';

  const nameButton = document.createElement('button');
  nameButton.textContent = 'Name this person';
  nameButton.addEventListener('click', async () => {
    const name = await promptPersonName('Who is this?');
    if (name) resolveDetection(detection.id, '/faces/confirm', { personName: name });
  });
  actions.appendChild(nameButton);

  const ignoreButton = document.createElement('button');
  ignoreButton.textContent = 'Ignore';
  ignoreButton.addEventListener('click', () => resolveDetection(detection.id, '/faces/ignore', {}));
  actions.appendChild(ignoreButton);

  const strangerButton = document.createElement('button');
  strangerButton.textContent = 'Ignore as stranger';
  strangerButton.title = 'Never suggest this face again, on any photo';
  strangerButton.addEventListener('click', () => resolveDetection(detection.id, '/faces/ignore-stranger', {}));
  actions.appendChild(strangerButton);

  card.appendChild(actions);
  return card;
}

// A box of every pending detection presumed to be the same Person,
// approved together in one action rather than one at a time. Removing
// one (the [-] button) rejects that specific suggestion server-side
// (/faces/reject-suggestion) — not just a local, cosmetic removal — so
// it is re-matched against everyone else and refreshes into wherever it
// now belongs (a different group, "Unidentified", or gone entirely if
// the next-best match turns out to be a suppressed stranger), rather
// than reappearing under the same wrong name the next time this screen
// opens.
function renderMatchGroup(personName, detections) {
  const box = document.createElement('div');
  box.className = 'face-match-group';

  // Shared by "Confirm all as <name>" and "Reassign all to…" below: both
  // are the same bulk operation, just with a different target name — the
  // suggested one, or one the reviewer picks because the whole group
  // turned out to be the wrong person.
  async function confirmAllAs(targetName, controlEl) {
    controlEl.disabled = true;
    // Attempts every detection regardless of an earlier one failing, and
    // always refreshes the review screen afterward — a version of this
    // that aborted the loop and skipped the refresh on the first error
    // left already-succeeded confirmations stuck showing as still
    // pending, and retrying re-sent the whole batch in the same order,
    // which 400s immediately on whichever one had already gone through
    // (see Spec.md's Face Recognition section) rather than ever reaching
    // the ones after it.
    const errors = [];
    for (const detection of detections) {
      try {
        await postEdit('/faces/confirm', { detectionId: detection.id, personName: targetName });
      } catch (err) {
        errors.push(err.message);
      }
    }
    await openFacesReview();
    if (errors.length > 0) {
      window.alert(`${errors.length} face(s) could not be confirmed as ${targetName} (the rest were applied):\n${errors.join('\n')}`);
    }
  }

  const header = document.createElement('div');
  header.className = 'face-match-group-header';
  const title = document.createElement('span');
  title.textContent = `Presumed: ${personName} (${detections.length})`;
  const confirmAllButton = document.createElement('button');
  confirmAllButton.textContent = `Confirm all as ${personName}`;
  confirmAllButton.addEventListener('click', () => confirmAllAs(personName, confirmAllButton));
  header.appendChild(title);
  header.appendChild(confirmAllButton);
  box.appendChild(header);

  const reassignAllRow = document.createElement('div');
  reassignAllRow.className = 'face-match-group-reassign-all';
  const reassignAllInput = document.createElement('input');
  reassignAllInput.type = 'text';
  reassignAllInput.className = 'face-match-group-reassign-input';
  reassignAllInput.placeholder = 'Reassign all to… (Enter)';
  reassignAllInput.title = `If this whole group is actually someone else, type their name and press Enter to confirm all ${detections.length} as them instead`;
  reassignAllInput.setAttribute('list', 'person-datalist');
  reassignAllInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = reassignAllInput.value.trim();
    if (name) confirmAllAs(name, reassignAllInput);
  });
  reassignAllRow.appendChild(reassignAllInput);
  box.appendChild(reassignAllRow);

  const thumbsEl = document.createElement('div');
  thumbsEl.className = 'face-match-thumbs';
  for (const detection of detections) {
    const thumb = document.createElement('div');
    thumb.className = 'face-match-thumb';

    const canvas = document.createElement('canvas');
    thumb.appendChild(canvas);
    drawFaceCrop(canvas, detection).catch(() => {});

    const removeButton = document.createElement('button');
    removeButton.className = 'face-match-thumb-remove';
    removeButton.textContent = '−';
    removeButton.title = `Not ${personName} — remember that and try matching again`;
    removeButton.addEventListener('click', () => resolveDetection(detection.id, '/faces/reject-suggestion', {}));
    thumb.appendChild(removeButton);

    // Reassigning this one face directly, without waiting for the [-]
    // button's guess-again matching: typed here rather than in a modal,
    // sharing the same known-people autocomplete list (#person-datalist,
    // kept filled — see openFacesReview) as the lookup dialog below.
    const reassignInput = document.createElement('input');
    reassignInput.type = 'text';
    reassignInput.className = 'face-match-thumb-input';
    reassignInput.placeholder = 'Reassign… (Enter)';
    reassignInput.setAttribute('list', 'person-datalist');
    reassignInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const name = reassignInput.value.trim();
      if (name) resolveDetection(detection.id, '/faces/confirm', { personName: name });
    });
    thumb.appendChild(reassignInput);

    const thumbActions = document.createElement('div');
    thumbActions.className = 'face-match-thumb-actions';

    const ignoreButton = document.createElement('button');
    ignoreButton.textContent = 'Ignore';
    ignoreButton.addEventListener('click', () => resolveDetection(detection.id, '/faces/ignore', {}));
    thumbActions.appendChild(ignoreButton);

    const strangerButton = document.createElement('button');
    strangerButton.textContent = 'Stranger';
    strangerButton.title = 'Never suggest this face again, on any photo';
    strangerButton.addEventListener('click', () => resolveDetection(detection.id, '/faces/ignore-stranger', {}));
    thumbActions.appendChild(strangerButton);

    thumb.appendChild(thumbActions);
    thumbsEl.appendChild(thumb);
  }
  box.appendChild(thumbsEl);
  return box;
}

async function openFacesReview() {
  // openFacesReview is called after every confirm/ignore/reject action
  // (see resolveDetection and confirmAllAs), not only when the screen
  // first opens — without also refreshing the main grid here, a person
  // just confirmed from the review screen would not show up in it (its
  // people facet, its viewer tags) until something else happened to
  // trigger a fresh search(), such as changing a filter or reloading the
  // page, even though the underlying data was already correct.
  search();

  const response = await fetch('/api/faces/detections?status=pending');
  const { total, detections } = await response.json();

  // Nothing left to review — closes the full-screen panel rather than
  // leaving it open showing an empty "No faces waiting for review."
  // placeholder, since there is nothing left to do here once every
  // detection has been resolved (whether that was true when this screen
  // was first opened, or became true from the last action taken in it).
  if (total === 0) {
    facesReviewEl.classList.remove('open');
    facesReviewListEl.innerHTML = '';
    statusEl.textContent = 'Done matching — no faces left to review.';
    return;
  }

  document.querySelector('#faces-review-heading').textContent = `Review faces (${total} pending)`;
  facesReviewListEl.innerHTML = '';

  // Keeps #person-datalist filled for the inline reassign inputs on
  // each thumbnail below (see renderMatchGroup) — populated here rather
  // than only when the lookup dialog itself opens, since those inputs
  // need it without ever opening that dialog.
  fetchKnownPeople().then((people) => {
    knownPeople = people;
    personDatalistEl.innerHTML = '';
    for (const name of people) {
      const option = document.createElement('option');
      option.value = name;
      personDatalistEl.appendChild(option);
    }
  });

  // Presumed matches are grouped together, one box per suggested Person,
  // so several can be approved (or pruned of a wrong one) in a single
  // action; a detection with no suggestion gets its own card below.
  const matchGroups = new Map();
  const unmatched = [];
  for (const detection of detections) {
    if (!detection.suggestedPersonName) {
      unmatched.push(detection);
      continue;
    }
    if (!matchGroups.has(detection.suggestedPersonName)) matchGroups.set(detection.suggestedPersonName, []);
    matchGroups.get(detection.suggestedPersonName).push(detection);
  }

  for (const [personName, group] of matchGroups) {
    facesReviewListEl.appendChild(renderMatchGroup(personName, group));
  }

  if (unmatched.length > 0) {
    const heading = document.createElement('h3');
    heading.className = 'faces-review-subheading';
    heading.textContent = 'Unidentified';
    facesReviewListEl.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'faces-review-grid';
    for (const detection of unmatched) {
      grid.appendChild(renderFaceCard(detection));
    }
    facesReviewListEl.appendChild(grid);
  }

  facesReviewEl.classList.add('open');
}

document.querySelector('#faces-review-close').addEventListener('click', () => {
  facesReviewEl.classList.remove('open');
});

// Three top-level modes, switched via #mode-bar, never more than one
// screen visible at a time: Explore (the facets/grid/viewer, everything
// above), Scan (the sub-collection admin tree below), and Settings
// (below that). Each of Scan/Settings loads its own data lazily, once,
// the first time it is switched into — not on every switch back to it —
// so glancing at a tab does not repeat a directory walk (Scan) or a
// config re-read (Settings) it already has.
let overviewLoadedOnce = false;
let settingsLoadedOnce = false;

function switchMode(mode) {
  for (const key of Object.keys(screenEls)) {
    screenEls[key].classList.toggle('active', key === mode);
    modeButtonEls[key].classList.toggle('active', key === mode);
  }
  if (mode === 'scan' && !overviewLoadedOnce) {
    showAdminOverview().catch((err) => { adminStatusEl.textContent = `Error: ${err.message}`; });
  }
  if (mode === 'settings' && !settingsLoadedOnce) {
    loadSettings().catch((err) => { settingsStatusEl.textContent = `Error: ${err.message}`; });
  }
}

modeButtonEls.explore.addEventListener('click', () => switchMode('explore'));
modeButtonEls.scan.addEventListener('click', () => switchMode('scan'));
modeButtonEls.settings.addEventListener('click', () => switchMode('settings'));

// The "Sub-collections" scan screen — letting a large, decades-spanning
// collection be scanned a few sub-collections at a time from here, the
// same way the browser-tab SPA's own identical screen (index.html/
// src/main.js) already lets it be done client-side. The tree-building/
// rendering/checkbox logic itself (renderOverviewTree, selectedOverviewPaths,
// setAllCrateCheckboxes) is shared, byte-for-byte, with that other page
// — see overviewUI.js; only how an overview is fetched and how a
// selection is actually processed differs here: both are a round trip to
// this running server (src/core/admin/handler.js) rather than an
// in-browser File System Access API walk.
async function fetchOverview({ refresh = false } = {}) {
  const response = await fetch(`/api/admin/overview${refresh ? '?refresh=true' : ''}`);
  if (!response.ok) throw new Error(`Failed to load scan status: ${response.status}`);
  return response.json();
}

async function showAdminOverview({ refresh = false } = {}) {
  adminStatusEl.textContent = 'Checking collection status…';
  const overview = await fetchOverview({ refresh });
  renderOverviewTree({ sectionEl: overviewSectionEl, treeEl: overviewTreeEl, overview });
  adminStatusEl.textContent = overview.subCollections.length === 0
    ? 'Nothing found to scan.'
    : 'Select which sub-collections to scan below, then click Scan Selected.';
  overviewLoadedOnce = true;
  return overview;
}

overviewSelectAllButtonEl.addEventListener('click', () => setAllCrateCheckboxes(overviewTreeEl, true));
overviewSelectNoneButtonEl.addEventListener('click', () => setAllCrateCheckboxes(overviewTreeEl, false));
overviewRefreshButtonEl.addEventListener('click', () => {
  showAdminOverview({ refresh: true }).catch((err) => { adminStatusEl.textContent = `Error: ${err.message}`; });
});

// Scanned one sub-collection per request rather than the whole selection
// in one call — each is independent server-side (src/core/admin/handler.js
// takes a `subdirs` array either way), but going one at a time here is
// what lets the status line report real, incremental progress ("3 of 7")
// instead of a single, silent wait for however long the whole batch takes.
// The overview tree itself is also re-rendered after every one, so a
// large batch's status badges update live rather than all at once at
// the end.
overviewProcessButtonEl.addEventListener('click', async () => {
  const subdirs = [...selectedOverviewPaths(overviewTreeEl)];
  if (subdirs.length === 0) {
    adminStatusEl.textContent = 'Nothing selected.';
    return;
  }

  const controlButtons = [overviewSelectAllButtonEl, overviewSelectNoneButtonEl, overviewRefreshButtonEl, overviewProcessButtonEl];
  controlButtons.forEach((button) => { button.disabled = true; });

  let scannedCount = 0;
  const allFailedToLoad = [];
  try {
    for (let i = 0; i < subdirs.length; i++) {
      adminStatusEl.textContent = `Scanning ${subdirs[i]}… (${i + 1} of ${subdirs.length})`;
      const response = await fetch('/api/admin/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdirs: [subdirs[i]] }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Scan failed: ${response.status}`);

      scannedCount += result.scanned;
      allFailedToLoad.push(...result.failedToLoad);
      renderOverviewTree({ sectionEl: overviewSectionEl, treeEl: overviewTreeEl, overview: result.overview });
    }

    const failedNote = allFailedToLoad.length > 0
      ? ` — ${allFailedToLoad.length} skipped (an existing crate file could not be read; see the server's own console)`
      : '';
    adminStatusEl.textContent = `Scanned ${scannedCount} sub-collection(s).${failedNote}`;
    // The grid/facets/Collections panel need to pick up whatever this
    // scan just added, immediately, the same way they already do after
    // any other edit (see search's own callers elsewhere in this file).
    await loadCollections();
    await search();
  } catch (err) {
    adminStatusEl.textContent = `Error: ${err.message}`;
  } finally {
    controlButtons.forEach((button) => { button.disabled = false; });
  }
});

// The Settings screen — a config.json editor equivalent to the
// browser-tab SPA's own Settings section (index.html), extended here
// with the exclude-pattern lists that page has never exposed either
// (previously hand-edit-the-file only, in every mode). writeMetadataToFiles
// is read once at `rocphotos serve` startup (see bin/rocphotos.js), so a
// change saved here needs a server restart to actually take effect —
// stated plainly in the warning text below rather than implying it is
// immediate.
async function loadSettings() {
  settingsStatusEl.textContent = 'Loading…';
  try {
    const response = await fetch('/api/admin/config');
    if (!response.ok) throw new Error(`Failed to load settings: ${response.status}`);
    const config = await response.json();
    settingsWriteMetadataCheckbox.checked = config.writeMetadataToFiles;
    settingsExcludeDirsEl.value = config.excludeDirectories.join('\n');
    settingsExcludeFilesEl.value = config.excludeFiles.join('\n');
    settingsStatusEl.textContent = '';
    settingsLoadedOnce = true;
  } catch (err) {
    settingsStatusEl.textContent = `Error: ${err.message}`;
  }
}

settingsFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  settingsStatusEl.textContent = 'Saving…';
  try {
    const response = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writeMetadataToFiles: settingsWriteMetadataCheckbox.checked,
        excludeDirectories: settingsExcludeDirsEl.value.split('\n').map((line) => line.trim()).filter(Boolean),
        excludeFiles: settingsExcludeFilesEl.value.split('\n').map((line) => line.trim()).filter(Boolean),
      }),
    });
    if (!response.ok) throw new Error(`Save failed: ${response.status}`);
    settingsStatusEl.textContent = 'Saved. Restart rocphotos serve for the write-back setting to take effect; exclude patterns apply from the next scan.';
  } catch (err) {
    settingsStatusEl.textContent = `Error: ${err.message}`;
  }
});

loadCollections();
loadDates();
loadAlbumsList();
search();

// A brand new (or not-yet-touched) collection has nothing in the grid to
// show yet — switched to the Scan screen automatically here so there is
// always an obvious next step, rather than a silently empty grid. Never
// switches itself again once anything has been scanned, even partially,
// so it does not become a nag on every server restart.
fetchOverview()
  .then((overview) => {
    if (overview.subCollections.length > 0 && overview.subCollections.every((s) => s.status === 'not-scanned')) {
      renderOverviewTree({ sectionEl: overviewSectionEl, treeEl: overviewTreeEl, overview });
      overviewLoadedOnce = true;
      switchMode('scan');
    }
  })
  .catch(() => {});
