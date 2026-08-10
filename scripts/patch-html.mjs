/**
 * Injects the web head tags Expo cannot express.
 *
 * `app.json` only exposes a favicon, and `app/+html.tsx` is ignored when
 * `web.output` is "single" — Expo builds that index.html from its own template.
 * So the shell is patched after export instead. Everything here is static
 * markup; nothing depends on the bundle.
 *
 * Run automatically by `npm run build:web`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'dist', 'index.html');

if (!existsSync(INDEX)) {
  console.error('[patch-html] dist/index.html not found — run the export first.');
  process.exit(1);
}

const TITLE = 'Notomi — your study workspace';
const DESCRIPTION =
  'Upload your lectures, ask questions grounded in your own sources, and let your ' +
  'syllabus fill in your to-do list.';

const HEAD = `
    <meta name="description" content="${DESCRIPTION}" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Notomi" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta property="og:title" content="Notomi" />
    <meta property="og:description" content="Your study workspace, grounded in your own notes." />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="/icon-512.png" />
`;

let html = readFileSync(INDEX, 'utf8');
const before = html;

// viewport-fit=cover is what lets the layout reach under the iPhone notch;
// without it the safe-area insets the workspace shell reads are always zero.
html = html.replace(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />'
);

html = html.replace(/<title>[^<]*<\/title>/, `<title>${TITLE}</title>`);

// Idempotent: re-running must not stack duplicate tags.
if (!html.includes('apple-touch-icon')) {
  html = html.replace('</head>', `${HEAD}  </head>`);
}

if (html === before) {
  console.warn('[patch-html] nothing changed — Expo may have altered its template.');
  process.exit(1);
}

writeFileSync(INDEX, html);

const checks = [
  ['viewport-fit=cover', /viewport-fit=cover/],
  ['title', new RegExp(TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
  ['apple-touch-icon', /apple-touch-icon/],
  ['manifest', /manifest\.webmanifest/],
  ['favicon', /favicon\.ico/],
];

const missing = checks.filter(([, pattern]) => !pattern.test(html)).map(([name]) => name);
if (missing.length) {
  console.error(`[patch-html] FAILED to inject: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`[patch-html] injected ${checks.length} head features into dist/index.html`);
