// Local zero-dependency companion server for config-builder.html
// Enables direct 1-click saving of audit.config.json and native Windows File Explorer popups.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const htmlPath = join(repoRoot, 'docs', 'config-builder.html');

async function openInExplorer(targetPath) {
  const abs = resolve(repoRoot, targetPath);
  if (!existsSync(abs)) {
    try {
      await mkdir(abs, { recursive: true });
    } catch {
      // ignore
    }
  }
  if (process.platform === 'win32') {
    spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
  }
  return abs;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function parseBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        req.destroy();
        rejectBody(new Error('Body too large'));
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', rejectBody);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers for local loopback
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // 1. Serve HTML UI
    if (url.pathname === '/' || url.pathname === '/config-builder.html') {
      const html = await readFile(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // 2. GET /api/config: Read current audit.config.json or audit.config.example.json
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const wantExample = url.searchParams.get('source') === 'example';
      const configTarget = join(repoRoot, 'audit.config.json');
      const fallbackTarget = join(repoRoot, 'audit.config.example.json');
      const target = wantExample
        ? (existsSync(fallbackTarget) ? fallbackTarget : null)
        : (existsSync(configTarget) ? configTarget : existsSync(fallbackTarget) ? fallbackTarget : null);

      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'No config file found' }));
        return;
      }

      const content = await readFile(target, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        source: target === configTarget ? 'audit.config.json' : 'audit.config.example.json',
        isDefault: target !== configTarget,
        config: JSON.parse(content)
      }));
      return;
    }

    // 3. POST /api/config: Save directly to audit.config.json
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const raw = await parseBody(req);
      const parsed = JSON.parse(raw);
      const target = join(repoRoot, 'audit.config.json');
      await writeFile(target, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: target }));
      return;
    }

    // 4. POST /api/open: Open folder in native Windows File Explorer
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const raw = await parseBody(req);
      const { path: requestedPath } = JSON.parse(raw);
      if (!requestedPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Missing path' }));
        return;
      }
      const openedPath = await openInExplorer(requestedPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: openedPath }));
      return;
    }

    // 5. POST /api/create-folders: Safely create directories
    if (url.pathname === '/api/create-folders' && req.method === 'POST') {
      const raw = await parseBody(req);
      const { directories } = JSON.parse(raw);
      const results = [];
      for (const [key, dir] of Object.entries(directories ?? {})) {
        const abs = resolve(repoRoot, dir);
        if (existsSync(abs)) {
          results.push({ key, dir: abs, status: 'exists' });
        } else {
          await mkdir(abs, { recursive: true });
          results.push({ key, dir: abs, status: 'created' });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

const PORT = 4242;
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\n======================================================`);
  console.log(` Math Canvas Prep Config Server`);
  console.log(` Running at: ${url}`);
  console.log(` • Direct 1-click saving to audit.config.json enabled`);
  console.log(` • Native Windows File Explorer popups enabled`);
  console.log(`======================================================\n`);
  console.log(`Opening browser... Press Ctrl+C to stop.\n`);
  openBrowser(url);
});
