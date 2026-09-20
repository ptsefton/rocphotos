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

The application extracts EXIF metadata from images and adds it to the sub-crates (user can configure this, and a config file is kept at the root, app has a UI for mangaing it). If EXIF extraction for a given image fails or produces malformed data, the image is still added to the crate; the error is recorded in the `description` property of the image's `ImageObject` entity rather than causing the image to be skipped.

The app also maintains a sqlite database, an index of what it each sub-crate and the root RO-Crate, which is organised as per the AROCAPI API - https://github.com/crate-works/ro-crate-api. Each ImageObject gets an entry in the database as do Person entities (when get to specifying that later, there will be code to extract identified regions in the EXIF that are labelled with People, and people entities in the sub-crate AND the root crate will have people, once that's working we will then move on to other constructs around the collection like events (weddings, festivales, parties etc) and then on to supportin arbitraty contextual descriptions). The app can run in a mode that provides this API locally but also can run it inside the browser-based process (Note to Claude -- is this possible??). 

This means there should be a little stand alone AROCAPI app that's embedded in this app that can be fed info about entities in a (virtual?) internal API.

### 3.1 Excluding Directories from the Walk

Certain directories must never be treated as, or searched within for, a crate. Dotfiles and dot-directories (`.git`, editor and OS metadata, and similar) are excluded by default, since they are near-universal filesystem noise unrelated to photo storage. The application's own generated `thumbnails/` cache directory (see Section 3.2) is always excluded, regardless of configuration, since including it would cause the application to mistake its own output for source images on a later scan.

Beyond these, a collection may contain directories that are not part of the application's default exclusions but should still never be scanned — for example, a static HTML gallery previously exported by another tool, sitting inside what is otherwise a legitimate day-of-photos directory. To handle this, the application reads an optional `rocphotos.config.json` file from the root of the directory being scanned:

```json
{ "excludeDirectories": ["^\\.", "^HTML"] }
```

`excludeDirectories` is a list of regular expressions, each tested against a directory's own name (not its full path), at any depth in the walk. When present, this list is used in place of the built-in dotfile default, so a configuration that still wants dotfiles excluded restates that pattern explicitly, keeping the effective stop-list fully visible in one place. This file is read through the same filesystem interface as everything else, so it is honoured identically by the command-line tool and by the browser SPA, which can only read files inside the directory the user has granted it access to.

### 3.2 Thumbnails

Operating system thumbnail caches (for example, Windows `Thumbs.db`, macOS Finder/QuickLook previews, or the freedesktop.org thumbnail cache on Linux) are not used as a source of thumbnails. These caches are stored outside the directory tree granted to the application via the File System Access API, are not portable with the crate, and in some cases use undocumented or proprietary formats.

Instead, the application generates its own thumbnails at the time a sub-collection crate is created or rescanned, reusing a thumbnail already on disk (however it was produced) rather than regenerating it. In the browser SPA this uses the Canvas API; the command-line tool generates thumbnails equivalently using an image-processing library (`sharp`), since no browser Canvas is available there. Either path may occasionally be unable to produce a thumbnail for a given format; when that happens, the image is still added to the crate, and its generated pages fall back to displaying the full-size image. Thumbnails are stored in a `thumbnails/` subdirectory within each sub-collection crate directory, so that they are visible to the user in the filesystem, travel with the crate, and are listed as `hasPart` files of the crate. One thumbnail size is generated by default (for example, 400 pixels on the longest edge, encoded as JPEG); additional preview sizes may be added in future without requiring a change to this data model.

### 3.3 HTML Preview Pages

At scan time, the application writes a static `ro-crate-preview.html` file into every crate directory, alongside its `ro-crate-metadata.json`.

- In a sub-collection crate directory, the preview page is a thumbnail grid of every image the crate contains. Each thumbnail's caption shows the image's filename, its date (when known), any recorded EXIF extraction error, and — where EXIF data was extracted — a small metadata table wrapped in a collapsed `<details>` element, so the full EXIF listing is available without cluttering the grid.
- Clicking a thumbnail does not navigate to the raw image file directly; instead it opens a full-screen, in-page viewer showing the full-resolution image sized to fit the screen, with the same EXIF table available to expand, and a control to close it. This viewer is implemented in pure HTML and CSS (no JavaScript), so it works identically whether the page is served or opened directly via the `file://` protocol.
- In the root crate directory, the preview page provides date-based navigation: sub-collection crates are grouped into collapsible sections by year, then by month, and sorted chronologically (most recent first), each leaf entry linking to that sub-collection's own preview page. Only the most recent year, and its most recent month, are expanded by default; this keeps a collection spanning many years or decades manageable rather than presenting one long flat list. A sub-collection's representative date is the earliest EXIF date among the images it contains, not any naming convention of its directory path. Sub-collections with no dated images are listed separately under an "Undated" heading. Additional finding aids (for example, by subject or by camera) may be added in future without changing this data model.
- In the degenerate case where the root directory itself directly contains images (see Section 2), the root's preview page is a thumbnail grid, as for a sub-collection crate, rather than date-based navigation.

All relative links between generated pages, and from a generated page to an image or thumbnail file, are built as complete relative paths with every path segment percent-encoded, so that they resolve correctly under the `file://` protocol regardless of special characters (spaces, `#`, `?`, `%`, etc.) present in real filenames or directory names.

These pages are regenerated in full on every scan or rescan and are not treated as part of the crate's own metadata graph.

Each source photo's `ImageObject` entity is linked to its corresponding thumbnail `ImageObject` entity using the Schema.org `thumbnail` property, following standard Schema.org convention.

### 3.4 Future Features

A future release will have:

- A database to make navigation richer.
- Metadata editing, with options to write back to images.
- Face and possibly subject recognition, using open interoperability conventions for writing face regions into images and/or the file system.
- An RO-Crate MASP ("Machine Actionable Schemas and Profiles", as used in [collection2crate](https://github.com/Language-Research-Technology/collection2crate)) for this photo collection structure, to be authored once a representative set of example crates has been produced by the application.

## 4. Implementation Basics

### 4.1 Application Type

The application is a single-page application (SPA) that executes in three modes:

1. entirely within the Google Chrome browser. It requires no server-side component. All processing, including file access, metadata extraction, and RO-Crate manifest generation, is performed client-side.
2. As an app that runs on a user's computer - with the same interface but which can be left running more easily
3. As a set of commandline tools for doing directory scans, and building hte basic indexes used by the tool

### 4.2 File System Access

The application accesses the local file system through the browser's File System Access API. The user selects a root directory via a directory picker, and the application is granted a handle to that directory for the duration of the session. All read and write operations, including the creation and updating of `ro-crate-metadata.json` files and any associated photo or thumbnail files, are performed against this directory handle. No files are uploaded to a remote server.

### 4.3 Technology Stack

- **Language:** JavaScript (ES modules).
- **Build tooling:** Vite, consistent with the build framework used by the [collection2crate](https://github.com/Language-Research-Technology/collection2crate) project.
- **RO-Crate handling:** The [`ro-crate`](https://www.npmjs.com/package/ro-crate) npm package (source repository [`ro-crate-js`](https://github.com/Language-Research-Technology/ro-crate-js)) is used for construction, parsing, and validation of RO-Crate metadata.
- **Target runtime:** Google Chrome (or other browsers implementing the File System Access API). No support for legacy browsers is required.

### 4.4 Architecture Constraints

- The application does not depend on a backend server or database. Persistent state is limited to the contents of the selected directory and the RO-Crate metadata file it contains.
- The application does not transmit photo files or metadata to any external service.
- The application operates on a single directory tree selected by the user at the start of a session.

### 4.5 Testability and Filesystem Abstraction

Core operations, including directory traversal, crate boundary detection, EXIF extraction, and RO-Crate metadata construction, are implemented as pure functions decoupled from the browser's File System Access API. These functions depend only on a minimal filesystem adapter interface (directory listing, file reading, file writing), so that they are unit-testable and can be exercised from the command line via a Node.js implementation of the adapter with full, unrestricted filesystem access, in addition to the browser implementation used by the SPA. This allows the crate-building logic to be developed and verified without a browser, and reused unmodified inside the browser application.
