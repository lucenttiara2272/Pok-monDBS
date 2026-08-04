#!/usr/bin/env node
/**
 * Minimal static file server for local development.
 *
 *   npm run serve            # http://localhost:8000
 *   npm run serve -- 3000    # a different port
 *
 * This used to be `python3 -m http.server`, which fails on a Windows machine
 * without Python installed — and on Windows 10/11 the `python3` alias helpfully
 * opens the Microsoft Store instead of erroring cleanly. Node is already a
 * dependency of this project, so serving with Node removes the second runtime.
 *
 * The app needs a real HTTP origin because it uses ES modules and fetch, both of
 * which browsers refuse to run from a file:// URL.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    // strip the query string — asset URLs carry a ?v= cache-busting stamp
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let rel = normalize(urlPath).replace(/^([/\\])+/, '');
    if (rel === '' || rel.endsWith(sep) || rel.endsWith('/')) rel = join(rel, 'index.html');

    const file = join(root, rel);
    // never serve anything outside the project directory
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);

    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      // always revalidate, so an edit shows up on refresh during development
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404  ${req.url}`);
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500  ${e && e.message}`);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: npm run serve -- ${port + 1}`);
    process.exit(1);
  }
  throw e;
});

server.listen(port, () => {
  console.log(`PTCG Deck Lab  →  http://localhost:${port}`);
  console.log('Ctrl+C to stop.');
});
