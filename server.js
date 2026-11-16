// Servidor local: node server.js  (na Vercel é usado api/index.js)
const http = require('http'), fs = require('fs'), path = require('path');
const { handle } = require('./lib/core');
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let body = ''; req.on('data', c => { body += c; if (body.length > 3e5) req.destroy(); });
    req.on('end', async () => {
      const [code, obj] = await handle(req.method, url.pathname, req.headers.authorization, body, req.socket.remoteAddress);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj));
    });
    return;
  }
  const root = path.join(__dirname, 'public');
  const f = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[\/])+/, ''));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('404'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}).listen(PORT, () => console.log('App de viagens rodando em http://localhost:' + PORT));
