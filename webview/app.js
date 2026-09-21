const IMAGE_ENTITY_TYPE = 'http://pcdm.org/models#Object';
const FACET_NAMES = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'year'];
const FACET_LABELS = { camera: 'Camera', lens: 'Lens', keyword: 'Keywords', rating: 'Rating', people: 'People', pets: 'Pets', year: 'Year' };

const facetsEl = document.querySelector('#facets');
const activeFiltersEl = document.querySelector('#active-filters');
const statusEl = document.querySelector('#status');
const gridEl = document.querySelector('#grid');
const viewerEl = document.querySelector('#viewer');
const viewerImageEl = document.querySelector('#viewer-image');
const viewerCaptionEl = document.querySelector('#viewer-caption');
const viewerTagsEl = document.querySelector('#viewer-tags');
const viewerFacesEl = document.querySelector('#viewer-faces');
const viewerFacesToggleEl = document.querySelector('#viewer-faces-toggle');

// Face regions (with a bounding box) for the entity currently open in the
// viewer, redrawn whenever the overlay is shown and whenever the image's
// own rendered size changes (window resize, or a new image loading).
let currentFaceRegions = [];

// Every search implicitly scopes to images: this is a photo browser, not
// a general entity browser, so sub-collection Dataset entities never show
// up as tiles in the grid.
let activeFilters = {};

function entityUrl(base, id) {
  return `${base}/${encodeURIComponent(id)}`;
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
    renderFacets(result.facets);
    renderActiveFilters();
    renderGrid(result.entities);
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
    heading.textContent = FACET_LABELS[facetName];
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
    chip.textContent = `${FACET_LABELS[facetName]}: ${value}`;
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
  tag.textContent = value;
  tag.title = `Find more tagged "${value}"`;
  tag.addEventListener('click', () => applyFilterAndCloseViewer(facetName, value));
  viewerTagsEl.appendChild(tag);
}

async function openViewer(entity) {
  viewerImageEl.src = entityUrl('/api/file', entity.id);
  viewerImageEl.alt = entity.name;
  viewerCaptionEl.textContent = entity.name;
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

    currentFaceRegions = (metadata.regions ?? []).filter(
      (region) => region.regionType === 'Face' && region.xPosition !== undefined,
    );
    viewerFacesToggleEl.disabled = currentFaceRegions.length === 0;
  } catch {
    // No metadata to show is not fatal: the image itself still displays.
  }
}

function closeViewer() {
  viewerEl.classList.remove('open');
  viewerImageEl.src = '';
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

function renderGrid(entities) {
  gridEl.innerHTML = '';
  for (const entity of entities) {
    const figure = document.createElement('figure');

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

    const caption = document.createElement('figcaption');
    caption.textContent = entity.name;
    figure.appendChild(caption);

    figure.addEventListener('click', () => openViewer(entity));
    gridEl.appendChild(figure);
  }
}

document.querySelector('#viewer-close').addEventListener('click', closeViewer);
viewerEl.addEventListener('click', (event) => {
  if (event.target === viewerEl) closeViewer();
});

search();
