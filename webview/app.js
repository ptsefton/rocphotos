const IMAGE_ENTITY_TYPE = 'http://pcdm.org/models#Object';
const FACET_NAMES = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'year'];
const FACET_LABELS = { camera: 'Camera', lens: 'Lens', keyword: 'Keywords', rating: 'Rating', people: 'People', pets: 'Pets', year: 'Year' };
const FACET_ICONS = { people: '👤', pets: '🐕', keyword: '🏷️' };

function labelWithIcon(facetName) {
  const icon = FACET_ICONS[facetName];
  return icon ? `${icon} ${FACET_LABELS[facetName]}` : FACET_LABELS[facetName];
}

const facetsEl = document.querySelector('#facets');
const activeFiltersEl = document.querySelector('#active-filters');
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
const viewerEl = document.querySelector('#viewer');
const viewerImageEl = document.querySelector('#viewer-image');
const viewerRatingEl = document.querySelector('#viewer-rating');
const viewerCaptionEl = document.querySelector('#viewer-caption');
const viewerTagsEl = document.querySelector('#viewer-tags');
const viewerFacesEl = document.querySelector('#viewer-faces');
const viewerFacesToggleEl = document.querySelector('#viewer-faces-toggle');

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
  viewerImageEl.alt = entity.name;
  viewerCaptionEl.textContent = entity.name;
  // entity.rating comes from the same search result the grid tile itself
  // was rendered from (see entityToJson in the handler), so this can be
  // shown immediately rather than waiting on the metadata fetch below.
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
    img.alt = entity.name;
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
    caption.textContent = entity.name;
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

document.querySelector('#viewer-delete').addEventListener('click', () => {
  if (!window.confirm('Delete this image? It will be moved to _rocphotos/trash, not permanently deleted.')) return;
  // Captured before closeViewer() runs, since that resets
  // currentViewerEntityId to null.
  const idToDelete = currentViewerEntityId;
  closeViewer();
  runEditAction(() => postEdit('/edit/delete', { ids: [idToDelete] }));
});

search();
