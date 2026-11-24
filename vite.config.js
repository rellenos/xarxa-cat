import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const WORKER_SRC = path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist', 'maplibre-gl-worker.mjs');
const WORKER_OUT = 'vendor/maplibre-gl-worker.mjs';

// MapLibre 6 runs its worker from a separate, self-contained module. Vite would inject its
// HMR client into that file (which hangs the worker), so serve / emit it untouched instead.
function maplibreWorker() {
  return {
    name: 'maplibre-worker',
    configureServer(server) {
      server.middlewares.use(`/${WORKER_OUT}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        fs.createReadStream(WORKER_SRC).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WORKER_OUT, source: fs.readFileSync(WORKER_SRC) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [maplibreWorker()],
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { chunkSizeWarningLimit: 1500 },
});
