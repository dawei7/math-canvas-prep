// Bundles the desktop app with esbuild: the main process and the preload script (CommonJS, with pdf.js and the canvas left
// as ordinary dependencies), and the renderer (an ES module bundle, with pdf.js's worker, fonts and decoders next to it).
// The core package is bundled into the main process, so the packaged app needs no workspace links.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'out');
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
  // The core finds pdf.js's data next to its own file; in a CommonJS bundle that is this file.
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(out, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: [join(root, 'src/renderer/main.tsx')],
  outfile: join(out, 'renderer/renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome130',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ttf': 'file' },
  sourcemap: true,
  logLevel: 'info',
});

cpSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
cpSync(join(root, 'src/renderer/styles.css'), join(out, 'renderer/styles.css'));
cpSync(join(pdfjsRoot, 'build/pdf.worker.mjs'), join(out, 'renderer/pdf.worker.mjs'));
for (const folder of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  if (existsSync(join(pdfjsRoot, folder))) cpSync(join(pdfjsRoot, folder), join(out, 'renderer', folder), { recursive: true });
}
console.log('desktop app bundled to apps/desktop/out');
