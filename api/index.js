// Função serverless da Vercel: recebe todas as chamadas /api/*
const { handle } = require('../lib/core');
module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.searchParams.get('p') ? '/api/' + u.searchParams.get('p') : u.pathname; // a rewrite passa o caminho em ?p=
  let body = '';
  if (req.method !== 'GET') { for await (const c of req) { body += c; if (body.length > 1e5) break; } }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
  const [code, obj] = await handle(req.method, pathname, req.headers.authorization, body, ip);
  res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};
