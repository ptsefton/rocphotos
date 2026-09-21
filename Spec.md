# RO-Crate Image Manager irocrate — Specification

## 1. Purpose and Scope

This application is designed to maintain "at rest" collections of imgages and metadata about them including phorographs and scans on a filesystem using nested RO-Crate packages (in a structure that is, by default, only two levels deep). Irocrate allows Where possible, metadata is synchronised between images and the RO-Crate structure, but it allows for another layer of descriptive data that ties images together, with data about people and other agents, events and so on.

The point of having the RO-Crates, with HTML views, is to provide a standards-based mechanism to describe collections, so that a 'parked' collection has basic navigation built it and important metadata, as defined by the collection's custodian(s), is avaiable without having to use any kind of application. The entire system functions with just an web browser to click around, view the collection by date, subject and whatever other metadata fields are chosen for the main navigation. 

The application adds RO-Crate HTML sites  crate hierarchy to provide static navigation through the collection, including basic configurable finding aids by time, subject, and image properties such as camera used (including people in the pictures and as photographers).

T

## 2. Data Model

The data structure is as follows:

1. The root of the collection is an RO-Crate (it has an `ro-crate-metadata.json` file). This contains 
2. Nested under this there is another layer of RO-Crate files that contain sub-collections, which are typically a directory of files, a day's photos, an upload from a camera in a single directory, or a set of scanned images, these may occur at any depth below the root but do not contain any further ro-crates. This accounts for typical ways of ordering image collections which may be scaffolded by date-based (/yyyy/mm/dd/) upload-from-camera-based or subject based approaches.

3. Crate depth is capped at two levels by default: the root crate and its immediate sub-collection crates. Sub-collection boundaries are determined by a top-down filesystem walk from the root: the first directory encountered that contains an image file becomes a sub-collection crate. Any further nested directories and images beneath that point, regardless of depth, are absorbed into that same sub-collection crate rather than becoming crates of their own.

## 3. Application Behaviour

On opening, the application scans the file tree and creates/updates a confif file with a view of the file system which is presented to the user so they can select a directory to work on, say a day, year, month of files at a time as adding data can take a while (as with all large scale photo managers). This config is saved, so the users sees a tree - map of where there are sub-collections (as defined in the data model), slect which ones to scan, if the crates are out of date (something has changes) and whether scanning is complete (marked by the app when it creates). Re-opening the app will find this config/map and open it.

Once the user has seent the overview and selected all folders or a subset to describe the app utomatically creates the root crate and sub-collection crates, traversing the directory structure and adding Image entities to the sub-collections if they are not already present. It also stores thumbnails in a subdirectory. Non-image files encountered during the walk are ignored and are not added to the crate.

The application extracts EXIF metadata from images and adds it to the sub-crates (user can configure this, and a config file is kept at the root, app has a UI for mangaing it). If EXIF extraction for a given image fails or produces malformed data, the image is still added to the crate; the error is recorded in the `description` property of the image's `ImageObject` entity rather than causing the image to be skipped. A thumbnail generation failure (see Section 3.3) is recorded the same way; if both an EXIF error and a thumbnail error occur for the same image, both are combined into that one `description`, so a file's full error state — used for both the retry logic below and for surfacing "this file has a problem" in the generated HTML preview — lives in one place, in the crate itself, rather than a separate log.

Reprocessing an image (re-reading it, re-extracting EXIF, and re-attempting a thumbnail) is skipped on a rescan if the source file's modification time has not changed since it was last processed — recorded as the `dateModified` property on the image's `ImageObject` entity — regardless of whether that previous attempt succeeded or recorded an error. This means a file that failed once (an unsupported format, corrupt data) is not retried on every subsequent scan; it is retried only once the file itself changes (for example, replaced with a working copy), keeping a rescan of a large, mostly-unchanged collection fast.

The application also maintains a SQLite index of the collection, organised as per the [AROCAPI specification](https://github.com/crate-works/ro-crate-api). See Section 3.2.

### 3.1 Excluding Directories and Files from the Walk

Certain directories must never be treated as, or searched within for, a crate. Dotfiles and dot-directories (`.git`, editor and OS metadata, and similar) are excluded by default, since they are near-universal filesystem noise unrelated to photo storage. The application's own generated `thumbnails/` cache directory (see Section 3.3) is always excluded, regardless of configuration, since including it would cause the application to mistake its own output for source images on a later scan.

Beyond these, a collection may contain directories, or individual files, that are not part of the application's default exclusions but should still never be scanned — for example, a static HTML gallery previously exported by another tool, sitting inside what is otherwise a legitimate day-of-photos directory, or a handful of stray images sitting loose in the collection root. To handle this, the application reads an optional `rocphotos.config.json` file from the root of the directory being scanned:

```json
{ "excludeDirectories": ["^\\.", "^HTML"], "excludeFiles": ["^Thumbs\\.db$"] }
```

`excludeDirectories` and `excludeFiles` are each a list of regular expressions, tested against a directory's or file's own name (not its full path), at any depth in the walk; a file matching `excludeFiles` is treated as though it were not there at all, both as a possible crate-triggering image and as a member of whichever crate it would otherwise belong to. When present, `excludeDirectories` is used in place of the built-in dotfile default, so a configuration that still wants dotfiles excluded restates that pattern explicitly, keeping the effective stop-list fully visible in one place; `excludeFiles` has no built-in default; there is no filename pattern that is universally junk. This file is read through the same filesystem interface as everything else, so it is honoured identically by the command-line tool and by the browser SPA, which can only read files inside the directory the user has granted it access to.

#### Loose Images in the Collection Root

Because the first directory encountered in the top-down walk that directly contains an image becomes a crate boundary (Section 2), an image file sitting loose directly in the collection root — alongside otherwise-legitimate year/month/day subdirectories — would make the walker treat the whole root as the sole crate, silently absorbing every subdirectory beneath it and hiding all of their crates. (This does not apply when the root directly holding images is the *only* content: that is the intended single-folder-collection behaviour described in Section 2, not an ambiguity to resolve.)

When the command-line tool detects this situation it lists the loose image files found and interactively asks the user to either move them into a new folder — prompting for a name, defaulting to `images` (or `images-2`, `images-3`, and so on, if the chosen name is already taken) — so they become an ordinary sub-collection crate, add them to the config's `excludeFiles` list so they are ignored on this and every future scan, or cancel the scan so nothing is touched. This interactive prompt requires a real terminal; it is not attempted when standard input is not a TTY.

The same resolution is also available non-interactively, for scripted use or once the user already knows what they want: `rocphotos scan <directory> --loose-root-images=move [--loose-root-images-folder=<name>]` or `--loose-root-images=ignore`, which resolves the situation immediately without prompting.

The browser SPA does not yet offer either the interactive prompt or the command-line flags; it currently just honours whatever `excludeFiles` the config already contains.

### 3.2 The SQLite Index (AROCAPI)

At scan time, the application also builds a SQLite index, `rocphotos-index.sqlite`, at the root of the scanned collection — one database per collection, covering the root crate and every sub-collection crate beneath it (there is no separate index file per sub-crate). This index is a read-only materialised view of what scanning has already written to the crate JSON; it is not a second source of truth, and nothing writes to a crate's `ro-crate-metadata.json` by going through the index.

The schema is a minimal subset of the [AROCAPI specification](https://github.com/crate-works/ro-crate-api), drawn from the [PCDM](http://pcdm.org/models) vocabulary:

- `ro_crates(id, path, name, created_at, updated_at)` — one row per crate directory (the root and every sub-collection crate).
- `entities(id, ro_crate_id, entity_type, name, description, member_of, metadata_license_id, content_license_id, access_metadata, access_content, date_created)` — one row per crate-as-Collection and one row per image-as-Object.
- `files(id, entity_id, filename, media_type, size, relative_path, access_content)` — the actual image bytes backing an Object entity.
- `entity_facets(entity_id, facet_name, value)` — one row per (entity, facet, value) triple, indexed on `(facet_name, value)` and on `entity_id`.

`entity_facets` is a single generic index for every faceted-search field, rather than a dedicated column or join table per facet. It treats a facet with several values per entity (keyword) and one with at most one (camera, lens) the same way, and adding a new facet is new rows, never a schema change. The current facets, all derived from EXIF/IPTC/XMP at scan time and populated only for image entities, are: `camera` (combines `Make` and `Model`, e.g. "Google Pixel 6a"), `lens` (prefers `LensModel`, since it is typically already a full description such as "Pixel 6a back camera 4.38mm f/1.73", falling back to `LensMake` alone otherwise), `keyword` (from IPTC `Keywords`, XMP `dc:subject`, or the Lightroom XMP extension `hierarchicalSubject`, in that preference order; a hierarchical entry such as `Bird|Nankeen Kestrel` is split on `|` and each level stored as its own separate keyword value, so an image tagged this way matches a search on either "Bird" or "Nankeen Kestrel"), and `rating` (the XMP star rating, 1-5; a rating of 0 is treated as no rating at all, since tools such as Lightroom write `Rating: 0` on every photo they touch, not only ones a person actually starred, so it carries no information). `year` is a further facet derived at query time from `date_created` rather than stored in `entity_facets`, since `date_created` is also used to sort search results and stays a plain column on `entities`. A facet's own currently-selected value never narrows that facet's own counts (only every *other* active filter does), so switching between values of the same facet stays possible. Further facets (subject, people, and so on, once that metadata exists) extend the same table, without any schema change.

Entity types follow PCDM's aggregation model: the root and every sub-collection crate are `http://pcdm.org/models#Collection`; every image is a `http://pcdm.org/models#Object` whose `member_of` points to the `id` of the Collection entity for the crate directory it belongs to. Entity `id` values reuse the same collection-relative path convention already used elsewhere (for example `2025/03/10/` for a sub-collection crate, `2025/03/10/photo.jpg` for an image, `./` for the root), so they are unique across the whole index without needing a separately minted URI scheme.

`ro_crates.id` and `entities.ro_crate_id` use this same crate-entity-id convention (`./` for the root, `<path>/` for a sub-crate), rather than a raw directory path, so that `ro_crates.id`, `entities.ro_crate_id`, a crate's own `entities.id`, and `entities.member_of` all agree for the same crate — every relationship is traceable by matching ids directly (including in the `export-excel` workbook), and the root crate is never a blank cell. `ro_crates.path` separately keeps the real, raw directory path for filesystem purposes (`.` for the root, never blank either).

AROCAPI requires a `metadataLicenseId`/`contentLicenseId` and access flags on every entity; since this application has no licensing or access-control model yet, a fixed placeholder license id is used and access is always recorded as open, pending any future multi-user or publishing use case.

The index is populated via Node's built-in `node:sqlite` module (no native dependency) from the command line; a browser-side equivalent (backed by an in-memory WASM SQLite build, loaded from and saved back to the same physical file via the File System Access API) is planned but not yet implemented, so building the index is currently a CLI/desktop-mode-only operation.

A companion command, `rocphotos export-excel <directory>`, dumps the index to a three-sheet `.xlsx` workbook (RO-Crates, Entities, Files), for manual review without any SQL knowledge required. A further `--include-entity-crates` option adds a fourth sheet with each entity's full, resolved RO-Crate JSON-LD document (its own "mini crate", per AROCAPI — the same document `GET /entity/{id}/metadata` below returns), including EXIF detail that has no column of its own in the Entities sheet; this makes the workbook much larger and is meant for debugging, not routine review.

#### AROCAPI Endpoints and the Web View

A read-only AROCAPI request handler serves the index: `GET /capabilities`, `GET /entities` (filterable by `entityType`, `memberOf`, and the facet fields, as query parameters), `GET /entity/{id}`, `GET /entity/{id}/metadata` (an entity's full, resolved JSON-LD document, as above), `GET /files`, `GET /file/{id}` (the actual image bytes), `GET /ro-crates`, `GET /ro-crate/{id}` (with its materialised entity ids), `GET /ro-crate/{id}/metadata` (that crate's `ro-crate-metadata.json`, served verbatim), and `POST /search` (filters plus a list of requested facets, returning matching entities and, for each requested facet, its value/count breakdown). An id that itself contains `/` (nearly every entity and file id does) is passed as a single, percent-encoded path segment. There is no write/deposit support: every crate is still created and updated only by scanning, never through this API.

A companion `GET /entity/{id}/thumbnail` route, not part of AROCAPI itself, serves an entity's thumbnail bytes (resolved from its crate data, the same way `/entity/{id}/metadata` is), so the web view below can load a small preview per image rather than the full-size original.

This handler is written as a pure function of a SQLite driver and a filesystem adapter, with no HTTP or browser dependencies of its own, so the same handler can be reused by more than one transport. Today, `rocphotos serve <directory>` (desktop mode; see Section 4.1) hosts it over plain `node:http`, bound to `127.0.0.1` only, under `/api/*`, alongside a small static web view (`webview/`) that queries `/api/search` to browse and facet-filter the collection by camera, lens, keyword, rating, and year, showing thumbnails and a full-screen viewer for the original image. Hosting the same handler from inside the browser-tab mode, via a Service Worker intercepting same-origin `fetch` calls so the same web view works there without any server process, is planned but not yet implemented — that mode's browser-side SQLite driver (mentioned above) would need to exist first.

### 3.3 Thumbnails

Operating system thumbnail caches (for example, Windows `Thumbs.db`, macOS Finder/QuickLook previews, or the freedesktop.org thumbnail cache on Linux) are not used as a source of thumbnails. These caches are stored outside the directory tree granted to the application via the File System Access API, are not portable with the crate, and in some cases use undocumented or proprietary formats.

Instead, the application generates its own thumbnails at the time a sub-collection crate is created or rescanned, skipping generation for a source file whose modification time has not changed since it was last processed (see Section 3). In the browser SPA this uses the Canvas API; the command-line tool generates thumbnails equivalently using an image-processing library (`sharp`), since no browser Canvas is available there. Either path may occasionally be unable to produce a thumbnail for a given format; when that happens, the image is still added to the crate, the failure is recorded in its `description` (and not retried until the file changes), and its generated pages fall back to displaying the full-size image. Thumbnails are stored in a `thumbnails/` subdirectory within each sub-collection crate directory, so that they are visible to the user in the filesystem, travel with the crate, and are listed as `hasPart` files of the crate. One thumbnail size is generated by default (for example, 400 pixels on the longest edge, encoded as JPEG); additional preview sizes may be added in future without requiring a change to this data model.

### 3.4 HTML Preview Pages

At scan time, the application writes a static `ro-crate-preview.html` file into every crate directory, alongside its `ro-crate-metadata.json`.

- In a sub-collection crate directory, the preview page is a thumbnail grid of every image the crate contains. Each thumbnail's caption shows the image's filename, its date (when known), any recorded EXIF extraction error, and — where EXIF data was extracted — a small metadata table wrapped in a collapsed `<details>` element, so the full EXIF listing is available without cluttering the grid.
- Clicking a thumbnail does not navigate to the raw image file directly; instead it opens a full-screen, in-page viewer showing the full-resolution image sized to fit the screen, with the same EXIF table available to expand, and a control to close it. This viewer is implemented in pure HTML and CSS (no JavaScript), so it works identically whether the page is served or opened directly via the `file://` protocol.
- In the root crate directory, the preview page provides date-based navigation: sub-collection crates are grouped into collapsible sections by year, then by month, and sorted chronologically (most recent first), each leaf entry linking to that sub-collection's own preview page. Only the most recent year, and its most recent month, are expanded by default; this keeps a collection spanning many years or decades manageable rather than presenting one long flat list. A sub-collection's representative date is the earliest EXIF date among the images it contains, not any naming convention of its directory path. Sub-collections with no dated images are listed separately under an "Undated" heading. Additional finding aids (for example, by subject or by camera) may be added in future without changing this data model.
- In the degenerate case where the root directory itself directly contains images (see Section 2), the root's preview page is a thumbnail grid, as for a sub-collection crate, rather than date-based navigation.

All relative links between generated pages, and from a generated page to an image or thumbnail file, are built as complete relative paths with every path segment percent-encoded, so that they resolve correctly under the `file://` protocol regardless of special characters (spaces, `#`, `?`, `%`, etc.) present in real filenames or directory names.

These pages are regenerated in full on every scan or rescan and are not treated as part of the crate's own metadata graph.

Each source photo's `ImageObject` entity is linked to its corresponding thumbnail `ImageObject` entity using the Schema.org `thumbnail` property, following standard Schema.org convention.

### 3.5 Future Features

A future release will have:

- Serving the AROCAPI web view and its endpoints from inside the browser-tab mode too (a Service Worker plus a browser-side SQLite driver), so the same web view works there without a server process. The CLI/desktop mode already has this (Section 3.2).
- `POST /search`'s write-side counterpart (deposits) is deliberately out of scope: crates are, and should stay, created and updated only by scanning.
- Person entities in the index and in each crate, extracted from identified face regions in image metadata; once that is working, further constructs such as events (weddings, festivals, parties) and arbitrary contextual descriptions around the collection. These would extend the facet set the same way camera/lens/date did.
- Metadata editing, with options to write back to images.
- Face and possibly subject recognition, using open interoperability conventions for writing face regions into images and/or the file system.
- An RO-Crate MASP ("Machine Actionable Schemas and Profiles", as used in [collection2crate](https://github.com/Language-Research-Technology/collection2crate)) for this photo collection structure, to be authored once a representative set of example crates has been produced by the application.

## 4. Implementation Basics

### 4.1 Application Type

The application is a single-page application (SPA) that executes in three modes:

1. Entirely within the Google Chrome browser: no server-side component, with file access via the File System Access API. All processing, including file access, metadata extraction, and RO-Crate manifest generation, is performed client-side. This mode covers scanning and building the collection; browsing it by the AROCAPI web view described in Section 3.2 is not yet available here (that needs the browser-side Service Worker/SQLite driver noted there).
2. As a long-running local process, started from the command line and left running, that serves the AROCAPI web view (Section 3.2) plus its HTTP endpoints, over `127.0.0.1` only, opened in a normal Chrome tab. This is a second, separate frontend from mode 1's scanning SPA, sharing the same underlying index and crates. This mode shares its implementation with the command-line tools (mode 3) rather than being a separately packaged native application.
3. As a set of command-line tools (`rocphotos scan`, `rocphotos export-excel`, `rocphotos serve`) for scanning directories, building the SQLite index, exporting it for review, and serving it (mode 2), with full, unrestricted filesystem access via Node.js.

### 4.2 File System Access

The application accesses the local file system through the browser's File System Access API. The user selects a root directory via a directory picker, and the application is granted a handle to that directory for the duration of the session. All read and write operations, including the creation and updating of `ro-crate-metadata.json` files and any associated photo or thumbnail files, are performed against this directory handle. No files are uploaded to a remote server.

### 4.3 Technology Stack

- **Language:** JavaScript (ES modules).
- **Build tooling:** Vite, consistent with the build framework used by the [collection2crate](https://github.com/Language-Research-Technology/collection2crate) project.
- **RO-Crate handling:** The [`ro-crate`](https://www.npmjs.com/package/ro-crate) npm package (source repository [`ro-crate-js`](https://github.com/Language-Research-Technology/ro-crate-js)) is used for construction, parsing, and validation of RO-Crate metadata.
- **Target runtime:** Google Chrome (or other browsers implementing the File System Access API). No support for legacy browsers is required.

### 4.4 Architecture Constraints

- The application does not depend on any backend server or database outside of what it manages itself: persistent state is limited to the contents of the selected directory, the RO-Crate metadata files it contains, and the SQLite index described in Section 3.2 — all stored inside that same directory tree, not in any separate service or external database. The SQLite database is jsut an index - it can always be regenerated from scratch.
- Where the application does run a server (mode 2 in Section 4.1), it is bound to `127.0.0.1` only: a single-user, local convenience layer, never reachable from another machine.
- The application does not transmit photo files or metadata to any external service.
- The application operates on a single directory tree selected by the user at the start of a session.

### 4.5 Testability and Filesystem Abstraction

Core operations, including directory traversal, crate boundary detection, EXIF extraction, and RO-Crate metadata construction, are implemented as pure functions decoupled from the browser's File System Access API. These functions depend only on a minimal filesystem adapter interface (directory listing, file reading, file writing), so that they are unit-testable and can be exercised from the command line via a Node.js implementation of the adapter with full, unrestricted filesystem access, in addition to the browser implementation used by the SPA. This allows the crate-building logic to be developed and verified without a browser, and reused unmodified inside the browser application.
