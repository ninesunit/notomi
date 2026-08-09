/**
 * pdf.js runs its parser in a Web Worker. Metro cannot bundle that worker as a
 * module, so we copy it into `public/`, which Expo emits verbatim at the root
 * of the web export. Serving it same-origin avoids a CDN dependency and keeps
 * the "no third-party services" promise intact.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.mjs',
];

const source = candidates.map((p) => join(root, p)).find((p) => existsSync(p));

if (!source) {
  console.warn('[copy-pdf-worker] pdfjs-dist worker not found; skipping.');
  process.exit(0);
}

const destination = join(root, 'public', 'pdf.worker.min.mjs');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`[copy-pdf-worker] ${source.replace(root + '/', '')} -> public/pdf.worker.min.mjs`);
