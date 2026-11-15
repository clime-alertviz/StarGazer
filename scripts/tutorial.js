import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const types = { '.html': 'text/html', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.vtt': 'text/vtt', '.srt': 'text/plain', '.md': 'text/plain', '.mp3': 'audio/mpeg' };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(resolve(root) + sep) || !types[extname(file)] || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end(); return;
    }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      status = 206;
    }
    res.writeHead(status, { 'Content-Type': types[extname(file)], 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
    if (req.method === 'HEAD') res.end(); else createReadStream(file, { start, end }).pipe(res);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
}).listen(4320, '127.0.0.1', () => console.log('StarGazer tutorial: http://127.0.0.1:4320 — Ctrl+C to stop.'));
