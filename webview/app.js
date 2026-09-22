const IMAGE_ENTITY_TYPE = 'http://pcdm.org/models#Object';
const FACET_NAMES = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'year'];
const FACET_LABELS = { camera: 'Camera', lens: 'Lens', keyword: 'Keywords', rating: 'Rating', people: 'People', pets: 'Pets', year: 'Year', memberOf: 'Collection' };
const FACET_ICONS = { people: '👤', pets: '🐕', keyword: '🏷️' };

function labelWithIcon(facetName) {
  const icon = FACET_ICONS[facetName];
  return icon ? `${icon} ${FACET_LABELS[facetName]}` : FACET_LABELS[facetName];
}

const facetsEl = document.querySelector('#facets');
const activeFiltersEl = document.querySelector('#active-filters');
const collectionsAllEl = document.querySelector('#collections-all');
const collectionsTreeEl = document.querySelector('#collections-tree');
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
const viewerEl = document.querySelector('#viewer');
const viewerImageEl = document.querySelector('#viewer-image');
const viewerRatingEl = document.querySelector('#viewer-rating');
const viewerCaptionEl = document.querySelector('#viewer-caption');
const viewerDescriptionEl = document.querySelector('#viewer-description');
const viewerTagsEl = document.querySelector('#viewer-tags');
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
    row.className = 'collection-row';
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
  span.className = 'collection-folder-name';
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
  collectionsTreeEl.querySelectorAll('.collection-row').forEach((row) => {
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

collectionsAllEl.addEventListener('click', () => {
  delete activeFilters.memberOf;
  search();
});

function addViewerTag(facetName, value) {
  const tag = document.createElement('button');
  tag.className = 'viewer-tag';
  const icon = FACET_ICONS[facetName];
  tag.textContent = icon ? `${icon} ${value}` : value;
  tag.title = `Find more tagged "${value}"`;
  tag.addEventListener('click', () => applyFilterAndCloseViewer(facetName, value));
  viewerTagsEl.appendChild(tag);
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
  currentFaceRegions = [];
  viewerFacesEl.innerHTML = '';
  viewerFacesEl.classList.add('hidden');
  viewerFacesToggleEl.textContent = 'Show faces';
  viewerFacesToggleEl.classList.remove('active');
  viewerFacesToggleEl.disabled = true;
  viewerEl.classList.add('open');

  // The grid only ever fetches the flat facet columns it needs for
  // search (see search() above); keywords, people/pets, and face regions
  // live in the entity's own full RO-Crate document, fetched only once a
  // photo is actually opened.
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

    // A pet is tagged the same way as a person (Type: "Pet" rather than
    // "Face" — MWG has no separate "animal face" region type), so it
    // belongs in the same overlay.
    currentFaceRegions = (metadata.regions ?? []).filter(
      (region) => (region.regionType === 'Face' || region.regionType === 'Pet') && region.xPosition !== undefined,
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
    const box = document.createElement('div');
    box.className = 'face-box';
    box.style.left = `${offsetX + region.xPosition * renderedWidth - (region.width * renderedWidth) / 2}px`;
    box.style.top = `${offsetY + region.yPosition * renderedHeight - (region.height * renderedHeight) / 2}px`;
    box.style.width = `${region.width * renderedWidth}px`;
    box.style.height = `${region.height * renderedHeight}px`;

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
async function computeEmbeddingForKnownRegion(imageId, area) {
  const img = await loadImage(entityUrl('/api/file', imageId));
  const centerX = area.x * img.naturalWidth;
  const centerY = area.y * img.naturalHeight;
  const boxW = area.w * img.naturalWidth;
  const boxH = area.h * img.naturalHeight;
  const pad = 0.6;
  const sx = Math.max(0, centerX - (boxW * (1 + pad)) / 2);
  const sy = Math.max(0, centerY - (boxH * (1 + pad)) / 2);
  const sw = Math.min(img.naturalWidth - sx, boxW * (1 + pad));
  const sh = Math.min(img.naturalHeight - sy, boxH * (1 + pad));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const result = await faceapi.detectSingleFace(canvas).withFaceLandmarks().withFaceDescriptor();
  return result ? Array.from(result.descriptor) : null;
}

// Every image id in the whole collection, regardless of the current
// filters/selection — used to scope the backfill step below (see
// recognizeFacesButtonEl's click handler): learning from an existing tag
// is a one-time, collection-wide bit of bookkeeping, not something that
// should depend on which directory happens to be open when "Recognize
// Faces" is clicked, unlike finding new faces, which is deliberately
// scoped to the current view. Already-backfilled regions are skipped
// server-side (see hasReferenceFaceForRegion), so repeating this over
// the whole collection on every click is cheap after the first pass.
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
// someone tagged throughout the whole collection.
async function backfillExistingRegions(imageIds) {
  const { regions } = await postEdit('/faces/existing-regions', {
    imageIds, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
  });
  for (let i = 0; i < regions.length; i += 1) {
    statusEl.textContent = `Learning known faces… (${i + 1}/${regions.length})`;
    const region = regions[i];
    const embedding = await computeEmbeddingForKnownRegion(region.imageId, region.area).catch(() => null);
    if (!embedding) continue; // not reliably re-detectable from its own tagged box; skip rather than fail the whole batch
    await postEdit('/faces/backfill-reference', {
      sourceImageId: region.imageId, sourceRegionId: region.sourceRegionId, personName: region.personName,
      embedding, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
    });
  }
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
    await backfillExistingRegions(await fetchAllImageIds());

    const { toScan } = await postEdit('/faces/scan-status', {
      imageIds: currentEntityIds, modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION,
    });

    for (let i = 0; i < toScan.length; i += 1) {
      statusEl.textContent = `Finding faces… (${i + 1}/${toScan.length})`;
      const faces = await detectFacesForImage(toScan[i]);
      await postEdit('/faces/detections', { imageId: toScan[i], modelName: FACE_MODEL_NAME, modelVersion: FACE_MODEL_VERSION, faces });
    }

    statusEl.textContent = `${currentEntityIds.length} image${currentEntityIds.length === 1 ? '' : 's'}`;
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
// one (the [-] button) only takes it out of this batch — it stays
// "pending" on the server and simply shows up again next time the
// review screen opens, the same as if it had never been grouped.
function renderMatchGroup(personName, initialDetections) {
  let detections = initialDetections;

  const box = document.createElement('div');
  box.className = 'face-match-group';

  const header = document.createElement('div');
  header.className = 'face-match-group-header';
  const title = document.createElement('span');
  const confirmAllButton = document.createElement('button');
  header.appendChild(title);
  header.appendChild(confirmAllButton);

  const thumbsEl = document.createElement('div');
  thumbsEl.className = 'face-match-thumbs';

  function renderThumbs() {
    title.textContent = `Presumed: ${personName} (${detections.length})`;
    thumbsEl.innerHTML = '';
    for (const detection of detections) {
      const thumb = document.createElement('div');
      thumb.className = 'face-match-thumb';

      const canvas = document.createElement('canvas');
      thumb.appendChild(canvas);
      drawFaceCrop(canvas, detection).catch(() => {});

      const removeButton = document.createElement('button');
      removeButton.className = 'face-match-thumb-remove';
      removeButton.textContent = '−';
      removeButton.title = 'Remove from this batch (leaves it pending for later)';
      removeButton.addEventListener('click', () => {
        detections = detections.filter((d) => d.id !== detection.id);
        if (detections.length === 0) {
          box.remove();
          return;
        }
        renderThumbs();
      });
      thumb.appendChild(removeButton);

      thumbsEl.appendChild(thumb);
    }
  }
  renderThumbs();

  confirmAllButton.textContent = `Confirm all as ${personName}`;
  confirmAllButton.addEventListener('click', async () => {
    confirmAllButton.disabled = true;
    try {
      for (const detection of detections) {
        await postEdit('/faces/confirm', { detectionId: detection.id, personName });
      }
      await openFacesReview();
    } catch (err) {
      window.alert(`Could not apply that change: ${err.message}`);
      confirmAllButton.disabled = false;
    }
  });

  box.appendChild(header);
  box.appendChild(thumbsEl);
  return box;
}

async function openFacesReview() {
  const response = await fetch('/api/faces/detections?status=pending');
  const { total, detections } = await response.json();
  document.querySelector('#faces-review-heading').textContent = `Review faces (${total} pending)`;
  facesReviewListEl.innerHTML = '';

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

loadCollections();
search();
