#!/usr/bin/env node
// static.mjs — server statico minimo per le build Vite, con fallback SPA.
//
//   node static.mjs <dist-dir> <port> [host]
//
// I percorsi senza estensione che non corrispondono a un file (/the-parlour,
// /the-parlour/hook, /oauth-popup/start…) ricevono index.html; un file con
// estensione che manca risponde 404 (un chunk mancante deve fallire come in
// produzione, non ricevere HTML con 200). Niente cache, niente compressione,
// niente controlli di aggiornamento in rete: risposte identiche a ogni giro.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [root0, port, host = '127.0.0.1'] = process.argv.slice(2);
if (!root0 || !port) {
  console.error('uso: node static.mjs <dist-dir> <port> [host]');
  process.exit(2);
}
const root = path.resolve(root0);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function send(res, status, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('read error'); return; }
    res.writeHead(status, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { pathname = '/'; }
  const file = path.join(root, pathname);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) return send(res, 200, file);
    if (!err && st.isDirectory() && fs.existsSync(path.join(file, 'index.html'))) return send(res, 200, path.join(file, 'index.html'));
    if (path.extname(pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    return send(res, 200, path.join(root, 'index.html'));
  });
});
server.listen(Number(port), host, () => console.log(`[static] ${root} su http://${host}:${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
