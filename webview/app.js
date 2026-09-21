const IMAGE_ENTITY_TYPE = 'http://pcdm.org/models#Object';
const FACET_NAMES = ['camera', 'lens', 'keyword', 'rating', 'year'];
const FACET_LABELS = { camera: 'Camera', lens: 'Lens', keyword: 'Keywords', rating: 'Rating', year: 'Year' };

const facetsEl = document.querySelector('#facets');
const activeFiltersEl = document.querySelector('#active-filters');
const statusEl = document.querySelector('#status');
const gridEl = document.querySelector('#grid');
const viewerEl = document.querySelector('#viewer');
const viewerImageEl = document.querySelector('#viewer-image');
const viewerCaptionEl = document.querySelector('#viewer-caption');

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

function openViewer(entity) {
  viewerImageEl.src = entityUrl('/api/file', entity.id);
  viewerImageEl.alt = entity.name;
  viewerCaptionEl.textContent = entity.name;
  viewerEl.classList.add('open');
}

function closeViewer() {
  viewerEl.classList.remove('open');
  viewerImageEl.src = '';
}

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
