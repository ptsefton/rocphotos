// The "Sub-collections" admin tree — building the nested tree from a flat
// overview list, rendering it with per-folder/per-crate checkboxes and
// status badges, and reading back which crates are currently selected.
// Shared, byte-for-byte, between the browser-tab SPA (src/main.js, which
// imports this file by its real path on disk — see vite.config.js's own
// comment on why webview/ is never bundled) and the server-served web
// view (webview/app.js, loaded here as a plain, unbundled ES module the
// same way every other webview/*.js file is). Neither mode's own crate
// scanning lives here — each wires this module's pure rendering/reading
// functions to its own way of fetching an overview and of actually
// processing a selection (in-browser for the SPA; a server round-trip
// for webview/app.js — see src/core/admin/handler.js).
//
// Deliberately not a self-wiring "controller": every function below takes
// the specific elements it needs as parameters rather than assuming any
// fixed ids, since the two pages this runs on cannot share ids for
// everything (webview/index.html already has its own, differently-purposed
// #select-all for the image grid) — only #overview-section/#overview-tree
// happen to match between the two pages, and even that is incidental, not
// relied on here.

/**
 * Arranges a flat sub-collection list (as the overview endpoint/module
 * produces — see src/core/overview.js's buildOverview) into the actual
 * directory tree above each crate boundary — a year, then a month, then a
 * day-crate, say, though the real shape depends entirely on the
 * collection's own layout. The flat list is what gets fetched/persisted
 * (simple, diffable); this tree is only ever computed from it in memory,
 * for rendering a collapsible overview that scales to a collection with
 * many hundreds of sub-collections, rather than one unbroken list of all
 * of them at once.
 *
 * @typedef {object} OverviewNode
 * @property {string} name - this node's own path segment (e.g. "2024"), or '' for the collection root
 * @property {string} path - full path from the collection root (e.g. "2024/03")
 * @property {boolean} isCrate
 * @property {'not-scanned'|'out-of-date'|'up-to-date'|'invalid'} [status] - only set when isCrate is true
 * @property {number} [imageCount] - only set when isCrate is true
 * @property {OverviewNode[]} children - empty for a crate
 * @property {{notScanned: number, outOfDate: number, upToDate: number, invalid: number, imageCount: number}} summary - totals over this node and every descendant crate
 *
 * @param {Array<{path: string, imageCount: number, status: string}>} subCollections
 * @returns {OverviewNode}
 */
export function buildOverviewTree(subCollections) {
  const root = { name: '', path: '', isCrate: false, children: [] };

  for (const sub of [...subCollections].sort((a, b) => a.path.localeCompare(b.path))) {
    if (sub.path === '') {
      // The root directory itself directly contains images: it is both
      // the root crate and the only crate (see the data model), so it
      // has no separate parent folder to nest under.
      root.isCrate = true;
      root.status = sub.status;
      root.imageCount = sub.imageCount;
      continue;
    }

    let node = root;
    let accPath = '';
    for (const part of sub.path.split('/')) {
      accPath = accPath ? `${accPath}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: accPath, isCrate: false, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.isCrate = true;
    node.status = sub.status;
    node.imageCount = sub.imageCount;
  }

  computeOverviewSummaries(root);
  return root;
}

function computeOverviewSummaries(node) {
  if (node.isCrate) {
    node.summary = {
      notScanned: node.status === 'not-scanned' ? 1 : 0,
      outOfDate: node.status === 'out-of-date' ? 1 : 0,
      upToDate: node.status === 'up-to-date' ? 1 : 0,
      invalid: node.status === 'invalid' ? 1 : 0,
      imageCount: node.imageCount,
    };
    return node.summary;
  }

  const summary = { notScanned: 0, outOfDate: 0, upToDate: 0, invalid: 0, imageCount: 0 };
  for (const child of node.children) {
    const childSummary = computeOverviewSummaries(child);
    summary.notScanned += childSummary.notScanned;
    summary.outOfDate += childSummary.outOfDate;
    summary.upToDate += childSummary.upToDate;
    summary.invalid += childSummary.invalid;
    summary.imageCount += childSummary.imageCount;
  }
  node.summary = summary;
  return summary;
}

const STATUS_LABELS = { 'not-scanned': 'Not scanned', 'out-of-date': 'Out of date', 'up-to-date': 'Up to date', invalid: 'Invalid crate file' };
const SUMMARY_LABELS = { notScanned: 'not scanned', outOfDate: 'out of date', upToDate: 'up to date', invalid: 'invalid' };

function summaryBadges(summary) {
  const wrap = document.createElement('span');
  wrap.className = 'summary-badges';
  for (const key of ['notScanned', 'outOfDate', 'upToDate', 'invalid']) {
    if (summary[key] === 0) continue;
    const badge = document.createElement('span');
    badge.className = `status-badge ${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    badge.textContent = `${summary[key]} ${SUMMARY_LABELS[key]}`;
    wrap.appendChild(badge);
  }
  return wrap;
}

// Recomputes one folder's own checkbox (checked/indeterminate) purely
// from its descendant crates' current checkbox state, without touching
// them — the counterpart to a folder checkbox's own change handler
// (below), which does the opposite: pushes its state down to its
// descendants. Keeping these as two separate, one-directional functions
// avoids a folder's checkbox ever re-triggering its own "push down"
// handler while it is only meant to be reflecting what is already there.
function syncFolderCheckbox(details) {
  const folderCheckbox = details.querySelector(':scope > summary input[type="checkbox"]');
  const crateBoxes = [...details.querySelectorAll('input[type="checkbox"][data-path]')];
  const checkedCount = crateBoxes.filter((c) => c.checked).length;
  folderCheckbox.checked = crateBoxes.length > 0 && checkedCount === crateBoxes.length;
  folderCheckbox.indeterminate = checkedCount > 0 && checkedCount < crateBoxes.length;
}

// After a crate's (or a folder's, once it has pushed its own state down
// to its descendants) checkbox changes, every ancestor folder's checkbox
// above it needs to reflect that too, all the way up, so a folder shows
// at a glance whether it is fully, partly, or not at all selected
// without expanding it.
function updateAncestorCheckboxes(fromEl) {
  let details = fromEl.closest('li')?.parentElement.closest('details');
  while (details) {
    syncFolderCheckbox(details);
    details = details.parentElement.closest('details');
  }
}

function renderOverviewNode(node, expandedPaths) {
  const li = document.createElement('li');

  if (!node.isCrate) {
    const details = document.createElement('details');
    details.dataset.path = node.path;
    if (expandedPaths.has(node.path)) details.open = true;

    const summary = document.createElement('summary');
    const row = document.createElement('span');
    row.className = 'tree-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      details.querySelectorAll('input[type="checkbox"][data-path]').forEach((c) => { c.checked = checkbox.checked; });
      checkbox.indeterminate = false;
      updateAncestorCheckboxes(checkbox);
    });
    row.appendChild(checkbox);

    const nameEl = document.createElement('span');
    nameEl.className = 'node-name';
    nameEl.textContent = node.name || '(root)';
    row.appendChild(nameEl);
    row.appendChild(summaryBadges(node.summary));

    summary.appendChild(row);
    details.appendChild(summary);

    const childList = document.createElement('ul');
    for (const child of node.children) {
      childList.appendChild(renderOverviewNode(child, expandedPaths));
    }
    details.appendChild(childList);
    li.appendChild(details);

    // Children are rendered (and their own checkboxes already set) above
    // this point, so the folder's own checkbox can now be derived from
    // them — bottom-up, one folder at a time, never pushing state back
    // down (that would wipe out each child's individually-computed
    // pre-selection the moment its parent folder was rendered).
    syncFolderCheckbox(details);
    return li;
  }

  const row = document.createElement('label');
  row.className = 'tree-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.path = node.path;
  // Pre-selected when there is work to do; a crate already up to date
  // has nothing to gain from being processed again.
  checkbox.checked = node.status !== 'up-to-date';
  checkbox.addEventListener('change', () => updateAncestorCheckboxes(checkbox));
  row.appendChild(checkbox);

  const nameEl = document.createElement('span');
  nameEl.className = 'node-name';
  nameEl.textContent = node.name || '(root)';
  row.appendChild(nameEl);

  const countEl = document.createElement('span');
  countEl.className = 'image-count';
  countEl.textContent = `${node.imageCount} image${node.imageCount === 1 ? '' : 's'}`;
  row.appendChild(countEl);

  const badge = document.createElement('span');
  badge.className = `status-badge ${node.status}`;
  badge.textContent = STATUS_LABELS[node.status];
  row.appendChild(badge);

  li.appendChild(row);
  return li;
}

// A tree, even a large one, is rendered collapsed except wherever the
// user has already chosen to expand it — collected before a re-render
// (after "Refresh Status" or "Process Selected") clears the DOM, and
// restored once the new tree is built, so re-rendering does not keep
// collapsing a collection the user is partway through drilling into.
function currentlyExpandedPaths(treeEl) {
  return new Set([...treeEl.querySelectorAll('details[open]')].map((el) => el.dataset.path));
}

/**
 * Renders `overview` (as returned by buildOverview, or fetched from
 * GET /admin/overview) into `treeEl`, showing/hiding `sectionEl` to match
 * whether there is anything to show at all.
 *
 * @param {object} params
 * @param {HTMLElement} params.sectionEl
 * @param {HTMLElement} params.treeEl
 * @param {{subCollections: Array<{path: string, imageCount: number, status: string}>}} params.overview
 */
export function renderOverviewTree({ sectionEl, treeEl, overview }) {
  const expandedPaths = currentlyExpandedPaths(treeEl);
  treeEl.innerHTML = '';

  const tree = buildOverviewTree(overview.subCollections);
  if (tree.isCrate) {
    // The whole collection is flat (the root itself is the only crate):
    // nothing to nest, so it is rendered as a single row, not a tree.
    const list = document.createElement('ul');
    list.appendChild(renderOverviewNode(tree, expandedPaths));
    treeEl.appendChild(list);
  } else {
    const list = document.createElement('ul');
    for (const child of tree.children) {
      list.appendChild(renderOverviewNode(child, expandedPaths));
    }
    treeEl.appendChild(list);
  }

  sectionEl.hidden = overview.subCollections.length === 0;
}

/**
 * @param {HTMLElement} treeEl
 * @returns {Set<string>} every currently-checked crate's path
 */
export function selectedOverviewPaths(treeEl) {
  return new Set(
    [...treeEl.querySelectorAll('input[type="checkbox"][data-path]:checked')].map((el) => el.dataset.path),
  );
}

/**
 * Checks or unchecks every crate checkbox, then re-derives every folder
 * checkbox from them (see syncFolderCheckbox) — the "Select All"/
 * "Select None" buttons' whole implementation.
 *
 * @param {HTMLElement} treeEl
 * @param {boolean} checked
 */
export function setAllCrateCheckboxes(treeEl, checked) {
  treeEl.querySelectorAll('input[type="checkbox"][data-path]').forEach((el) => { el.checked = checked; });
  treeEl.querySelectorAll('details').forEach(syncFolderCheckbox);
}
