/**
 * Keep pdf.js outside Metro's module graph.
 *
 * Metro gives a lazy `import('pdfjs-dist')` a numeric module id. An already-open
 * PWA can retain the old entry bundle across a deploy, then ask Firebase Hosting
 * for an async chunk from the previous release. Hosting returns the SPA shell
 * for that now-missing path and Metro reports "Requiring unknown module".
 *
 * The browser can load pdf.js as a normal same-origin ES module instead. Both
 * the parser and its worker are copied into `public/`, which Expo emits verbatim.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
  {
    label: 'parser',
    candidates: [
      'node_modules/pdfjs-dist/build/pdf.min.mjs',
      'node_modules/pdfjs-dist/build/pdf.mjs',
    ],
    destination: 'public/pdf.min.mjs',
  },
  {
    label: 'worker',
    candidates: [
      'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
      'node_modules/pdfjs-dist/build/pdf.worker.mjs',
    ],
    destination: 'public/pdf.worker.min.mjs',
  },
];

for (const asset of assets) {
  const source = asset.candidates.map((path) => join(root, path)).find((path) => existsSync(path));
  if (!source) {
    console.error(`[copy-pdf-worker] pdfjs-dist ${asset.label} not found.`);
    process.exit(1);
  }

  const destination = join(root, asset.destination);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  console.log(`[copy-pdf-worker] ${source.replace(root + '\\', '')} -> ${asset.destination}`);
}
