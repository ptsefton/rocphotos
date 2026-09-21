import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webviewDir = path.join(rootDir, 'webview');

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

// Serves the same webview/ directory the CLI's `serve` command reads
// directly off disk, at /webview/* in the browser SPA too — read at
// request/build time rather than duplicated into public/, so the two
// modes can never drift out of sync with each other.
function serveWebviewPlugin() {
  return {
    name: 'serve-webview-dir',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // In dev, src/sw.js is served from under /src/, whose default
        // maximum Service Worker scope is /src/ itself — this header is
        // what the built version gets for free by living at /sw.js
        // instead, letting the dev registration request the same
        // whole-origin scope (see registerServiceWorker in main.js).
        if (req.url.startsWith('/src/sw.js')) {
          res.setHeader('Service-Worker-Allowed', '/');
        }
        if (!req.url.startsWith('/webview/')) return next();
        const relative = decodeURIComponent(req.url.slice('/webview/'.length).split('?')[0]) || 'index.html';
        const filePath = path.join(webviewDir, relative);
        if (!filePath.startsWith(webviewDir)) return next();
        fs.readFile(filePath, (err, data) => {
          if (err) return next();
          const contentType = CONTENT_TYPES[path.extname(filePath)];
          if (contentType) res.setHeader('Content-Type', contentType);
          res.end(data);
        });
      });
    },
    generateBundle() {
      for (const name of fs.readdirSync(webviewDir)) {
        const filePath = path.join(webviewDir, name);
        if (fs.statSync(filePath).isFile()) {
          this.emitFile({ type: 'asset', fileName: `webview/${name}`, source: fs.readFileSync(filePath) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [serveWebviewPlugin()],
  build: {
    rollupOptions: {
      // src/sw.js is a second entry (a Service Worker, not part of the
      // main page), built alongside index.html — its own real ES module
      // rather than a hand-duplicated copy of the handler/driver/adapter
      // code it needs. It must land at a fixed, root-level /sw.js (not
      // hashed, not under assets/), since a Service Worker's maximum
      // allowed scope defaults to its own script's directory — /sw.js
      // can control the whole origin, an asset under /assets/ could not.
      input: {
        main: path.join(rootDir, 'index.html'),
        sw: path.join(rootDir, 'src/sw.js'),
      },
      output: {
        entryFileNames: (chunkInfo) => (chunkInfo.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
