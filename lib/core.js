// Núcleo do app (usado pelo servidor local e pela função da Vercel).
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---------- Armazenamento: Redis (Upstash, na Vercel) ou arquivo JSON (local) ----------
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const DB_KEY = 'viagem:db';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const store = REDIS_URL ? {
  async get() { const r = await fetch(REDIS_URL + '/get/' + DB_KEY, { headers: { Authorization: 'Bearer ' + REDIS_TOKEN } }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result ? JSON.parse(j.result) : null; },
  async set(o) { const r = await fetch(REDIS_URL + '/set/' + DB_KEY, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(o) }); const j = await r.json(); if (j.error) throw new Error(j.error); }
} : {
  async get() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; } },
  async set(o) { fs.mkdirSync(DATA_DIR, { recursive: true }); const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, DB_FILE); }
};

const DEF = { cfg: { fare: 0, origem: 'Serra Azul', destino: 'Ribeirão Preto', ciclo: 7, anchor: null, pix: '', msgFim: '' },
  driver: null, drivers: [], baixas: [], pass: [], trips: {}, pay: {}, sessions: {} };
let db, dirty = false;
const save = () => { dirty = true; };
async function openDb() {
  const d = await store.get();
  db = { ...JSON.parse(JSON.stringify(DEF)), ...(d || {}) }; db.cfg = { ...DEF.cfg, ...db.cfg };
  if (!db.cfg.anchor) { const x = new Date(todayBR() + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); db.cfg.anchor = x.toISOString().slice(0, 10); dirty = true; }
  if (db.driver) { db.drivers.push({ id: uid(), nome: 'Motorista', user: 'motorista', pin: db.driver }); db.driver = null; dirty = true; } // migra o motorista único antigo
  if (!db.migPago) { // pagamentos antigos eram por período; agora são por trecho
    const add = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    for (const k in db.pay) if (db.pay[k].paid) { const [start, pid] = k.split('|');
      for (let n = 0; n < db.cfg.ciclo; n++) { const t = db.trips[add(start, n) + '|' + pid]; if (t) for (const l of ['ida', 'volta']) if (t[l] && !t[l + 'Pago']) { t[l + 'Pago'] = true; t[l + 'PagoEm'] = start; } }
      delete db.pay[k].paid; }
    db.migPago = true; dirty = true;
  }
  const now = Date.now(); for (const t in db.sessions) if (db.sessions[t].exp < now) { delete db.sessions[t]; dirty = true; } // limpa sessões vencidas
}

// ---------- Utilidades ----------
const todayBR = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // YYYY-MM-DD
const nowBR = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date());
const weekday = s => new Date(s + 'T12:00:00').getDay();
const digits = s => String(s || '').replace(/\D/g, '');
const phoneKey = s => digits(s).slice(-11);
const hash = (pin, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, h: crypto.scryptSync(String(pin), salt, 32).toString('hex') });
const check = (pin, rec) => rec && crypto.timingSafeEqual(Buffer.from(hash(pin, rec.salt).h, 'hex'), Buffer.from(rec.h, 'hex'));
const uid = () => crypto.randomBytes(5).toString('hex');
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00'));

const attempts = new Map(); // limite de tentativas de login por IP
function throttled(ip) { const a = attempts.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); } attempts.set(ip, a); return a.n >= 10; }
const fail = ip => { attempts.get(ip).n++; };

// ---------- Estado por papel ----------
function stateFor(sess) {
  const base = { role: sess.role, today: todayBR(), cfg: db.cfg };
  if (sess.role === 'driver') {
    const d = db.drivers.find(x => x.id === sess.did);
    return { ...base, pass: db.pass.map(({ pin, ...p }) => p), trips: db.trips, pay: db.pay,
      baixas: db.baixas.slice(-40).reverse(), me: { id: d.id, nome: d.nome, user: d.user }, drivers: db.drivers.map(({ pin, ...x }) => x) };
  }
  const me = db.pass.find(p => p.id === sess.pid);
  const { pin, ...self } = me;
  const trips = {}, pay = {};
  for (const k in db.trips) if (k.endsWith('|' + me.id)) trips[k] = db.trips[k];
  for (const k in db.pay) if (k.endsWith('|' + me.id)) pay[k] = db.pay[k];
  const { msgFim, ...cfg } = db.cfg;
  return { ...base, cfg, pass: [self], trips, pay, me: self, baixas: db.baixas.filter(x => x.pid === me.id).slice(-20).reverse() };
}

// ---------- API ----------
const routes = {};
const R = (m, p, fn, role) => routes[m + ' ' + p] = { fn, role };

const userOk = u => /^[a-z][a-z0-9._-]{2,29}$/.test(u);
function newDriver(b) {
  const nome = String(b.nome || '').trim(), user = String(b.user || '').trim().toLowerCase();
  if (!nome) throw [400, 'Informe o nome do motorista'];
  if (!userOk(user)) throw [400, 'Usuário: 3 a 30 caracteres, começando com letra (letras, números, ponto, hífen ou sublinhado)'];
  if (db.drivers.some(d => d.user === user)) throw [400, 'Esse usuário já existe'];
  if (String(b.pin || '').length < 6) throw [400, 'A senha do motorista precisa ter ao menos 6 caracteres'];
  const d = { id: uid(), nome, user, pin: hash(b.pin) }; db.drivers.push(d); save(); return d;
}
R('GET', '/api/status', () => ({ setup: !db.drivers.length }));
R('POST', '/api/setup', b => {
  if (db.drivers.length) throw [403, 'Já configurado'];
  newDriver({ nome: b.nome || 'Motorista', user: b.user || 'motorista', pin: b.pin }); return { ok: true };
});
R('POST', '/api/login', (b, s, ip) => {
  if (throttled(ip)) throw [429, 'Muitas tentativas. Aguarde 15 minutos.'];
  let sess = null;
  const u = String(b.user || '').trim().toLowerCase(), drv = db.drivers.find(d => d.user === u);
  if (drv) { if (check(b.pin, drv.pin)) sess = { role: 'driver', did: drv.id }; }
  else { const p = db.pass.find(p => p.ativo !== false && phoneKey(p.tel) === phoneKey(b.user) && phoneKey(b.user).length >= 10); if (p && check(b.pin, p.pin)) sess = { role: 'passenger', pid: p.id }; }
  if (!sess) { fail(ip); throw [401, 'Usuário ou senha inválidos']; }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { ...sess, exp: Date.now() + 90 * 864e5 }; save();
  return { token, role: sess.role };
});
R('POST', '/api/logout', (b, s) => { delete db.sessions[s.token]; save(); return { ok: true }; }, 'any');
R('GET', '/api/state', (b, s) => stateFor(s), 'any');

// --- conta própria (motorista ou passageiro) ---
R('POST', '/api/password', (b, s) => {
  const nova = String(b.nova || '');
  const rec = s.role === 'driver' ? db.drivers.find(d => d.id === s.did) : db.pass.find(p => p.id === s.pid);
  if (nova.length < (s.role === 'driver' ? 6 : 4)) throw [400, s.role === 'driver' ? 'A nova senha precisa ter ao menos 6 caracteres' : 'O novo PIN precisa ter ao menos 4 dígitos'];
  if (!check(b.atual, rec.pin)) throw [403, 'A senha atual não confere'];
  rec.pin = hash(nova);
  for (const t in db.sessions) { const x = db.sessions[t]; if (t !== s.token && (s.role === 'driver' ? x.did === s.did : x.pid === s.pid)) delete db.sessions[t]; }
  save(); return { ok: true };
}, 'any');

// --- motorista ---
R('POST', '/api/driver', b => { const d = newDriver(b); return { ok: true, id: d.id }; }, 'driver');
R('POST', '/api/driver/delete', (b, s) => {
  if (b.id === s.did) throw [400, 'Você não pode remover a própria conta']; // evita ficar sem nenhum motorista
  const i = db.drivers.findIndex(d => d.id === b.id); if (i < 0) throw [404, 'Motorista não encontrado'];
  db.drivers.splice(i, 1); for (const t in db.sessions) if (db.sessions[t].did === b.id) delete db.sessions[t];
  save(); return { ok: true };
}, 'driver');
R('POST', '/api/driver/reset', b => { // define nova senha para outro motorista
  const d = db.drivers.find(x => x.id === b.id); if (!d) throw [404, 'Motorista não encontrado'];
  if (String(b.pin || '').length < 6) throw [400, 'A senha precisa ter ao menos 6 caracteres'];
  d.pin = hash(b.pin); for (const t in db.sessions) if (db.sessions[t].did === d.id) delete db.sessions[t];
  save(); return { ok: true };
}, 'driver');
R('POST', '/api/cfg', b => {
  const c = db.cfg, fare = parseFloat(b.fare);
  if (!(fare >= 0)) throw [400, 'Valor inválido'];
  Object.assign(c, { fare, origem: String(b.origem || '').trim() || 'Serra Azul', destino: String(b.destino || '').trim() || 'Ribeirão Preto',
    ciclo: b.ciclo == 14 ? 14 : 7, pix: String(b.pix || '').trim(), msgFim: String(b.msgFim || '').trim() });
  if (validDate(b.anchor)) { const d = new Date(b.anchor + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); c.anchor = d.toISOString().slice(0, 10); }
  save(); return { ok: true };
}, 'driver');
R('POST', '/api/pass', b => {
  const nome = String(b.nome || '').trim(); if (!nome) throw [400, 'Informe o nome'];
  if (phoneKey(b.tel).length < 10) throw [400, 'Telefone com DDD é obrigatório (é o login do passageiro)'];
  if (db.pass.some(p => p.id !== b.id && phoneKey(p.tel) === phoneKey(b.tel))) throw [400, 'Já existe passageiro com esse telefone'];
  let p = b.id && db.pass.find(x => x.id === b.id);
  if (!p) { if (String(b.pin || '').length < 4) throw [400, 'Defina uma senha (PIN) de ao menos 4 dígitos para o passageiro']; p = { id: uid(), ativo: true }; db.pass.push(p); }
  Object.assign(p, { nome, tel: String(b.tel).trim(), contato: ['whatsapp', 'ligacao', 'sms'].includes(b.contato) ? b.contato : 'whatsapp', tarifa: Math.max(0, parseFloat(b.tarifa) || 0) });
  if (b.pin) { if (String(b.pin).length < 4) throw [400, 'PIN deve ter ao menos 4 dígitos']; p.pin = hash(b.pin); for (const t in db.sessions) if (db.sessions[t].pid === p.id) delete db.sessions[t]; }
  if (typeof b.ativo === 'boolean') p.ativo = b.ativo;
  save(); return { ok: true };
}, 'driver');
R('POST', '/api/trip', b => { // motorista lança/corrige: {date,pid,leg,val}
  const p = db.pass.find(x => x.id === b.pid); if (!p || !validDate(b.date) || !['ida', 'volta'].includes(b.leg)) throw [400, 'Dados inválidos'];
  setLeg(p, b.date, b.leg, !!b.val, 'm'); save(); return { ok: true };
}, 'driver');
R('POST', '/api/day', b => { // marca/limpa o dia para todos os ativos
  if (!validDate(b.date)) throw [400, 'Data inválida'];
  for (const p of db.pass.filter(p => p.ativo !== false)) { setLeg(p, b.date, 'ida', !!b.val, 'm'); setLeg(p, b.date, 'volta', !!b.val, 'm'); }
  save(); return { ok: true };
}, 'driver');
R('POST', '/api/pay', b => {
  if (!db.pass.some(p => p.id === b.pid) || !validDate(b.start) || b.field !== 'sent') throw [400, 'Dados inválidos'];
  const k = b.start + '|' + b.pid, o = db.pay[k] || {}; o[b.field] = !!b.val; if (b.field === 'paid' && b.val) o.sent = true; db.pay[k] = o; save(); return { ok: true };
}, 'driver');

// Baixa (pagamento) por trecho: {items:[{pid,date,leg?}], val:true|false}. Sem leg = ida e volta do dia.
R('POST', '/api/baixa', (b, s) => {
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 1500) throw [400, 'Nada para dar baixa'];
  const val = b.val !== false, por = {};
  for (const it of b.items) {
    const t = db.trips[it.date + '|' + it.pid]; if (!t) continue;
    for (const l of (it.leg ? [it.leg] : ['ida', 'volta'])) {
      if (!['ida', 'volta'].includes(l) || !t[l] || !!t[l + 'Pago'] === val) continue;
      if (val) { t[l + 'Pago'] = true; t[l + 'PagoEm'] = todayBR(); } else { delete t[l + 'Pago']; delete t[l + 'PagoEm']; }
      const g = por[it.pid] || (por[it.pid] = { valor: 0, trechos: 0, de: it.date, ate: it.date });
      g.valor += t.fare; g.trechos++; if (it.date < g.de) g.de = it.date; if (it.date > g.ate) g.ate = it.date;
    }
  }
  let valor = 0, trechos = 0;
  for (const pid in por) { const g = por[pid]; valor += g.valor; trechos += g.trechos;
    db.baixas.push({ id: uid(), at: todayBR() + ' ' + nowBR(), pid, tipo: val ? 'baixa' : 'estorno', valor: +g.valor.toFixed(2), trechos: g.trechos, de: g.de, ate: g.ate, by: s.did }); }
  db.baixas = db.baixas.slice(-500);
  save(); return { ok: true, valor: +valor.toFixed(2), trechos };
}, 'driver');

// --- passageiro: sinaliza "ok" do embarque (somente hoje, só ele mesmo) ---
R('POST', '/api/boarding', (b, s) => {
  if (!['ida', 'volta'].includes(b.leg)) throw [400, 'Trecho inválido'];
  const d = todayBR(), w = weekday(d); if (w === 0 || w === 6) throw [400, 'O carro só roda de segunda a sexta'];
  const p = db.pass.find(x => x.id === s.pid);
  const tr = db.trips[d + '|' + p.id]; if (b.val === false && tr && tr[b.leg + 'Pago']) throw [400, 'Este trecho já foi pago e não pode ser desfeito'];
  setLeg(p, d, b.leg, b.val !== false, 'p'); save(); return { ok: true };
}, 'passenger');

function setLeg(p, date, leg, val, by) {
  const k = date + '|' + p.id, t = db.trips[k] || { ida: false, volta: false, fare: p.tarifa > 0 ? p.tarifa : db.cfg.fare };
  if (val && !t[leg]) { t[leg + 'At'] = nowBR(); t[leg + 'By'] = by; if (!t.ida && !t.volta) t.fare = p.tarifa > 0 ? p.tarifa : db.cfg.fare; }
  if (!val) { delete t[leg + 'At']; delete t[leg + 'By']; delete t[leg + 'Pago']; delete t[leg + 'PagoEm']; }
  t[leg] = val;
  if (!t.ida && !t.volta) delete db.trips[k]; else db.trips[k] = t;
}


// ---------- Entrada única: handle(method, pathname, authHeader, bodyText, ip) ----------
async function handle(method, pathname, authHeader, bodyText, ip) {
  const r = routes[method + ' ' + pathname]; if (!r) return [404, { error: 'Não encontrado' }];
  try {
    dirty = false; await openDb();
    let sess = null;
    if (r.role) {
      const tok = (authHeader || '').replace('Bearer ', '');
      sess = db.sessions[tok];
      if (!sess || sess.exp < Date.now()) return [401, { error: 'Sessão expirada' }];
      if (r.role !== 'any' && sess.role !== r.role) return [403, { error: 'Sem permissão' }];
      if (sess.role === 'driver' && !db.drivers.find(d => d.id === sess.did)) return [401, { error: 'Acesso removido' }];
      if (sess.role === 'passenger' && !db.pass.find(p => p.id === sess.pid && p.ativo !== false)) return [401, { error: 'Acesso desativado' }];
      sess = { ...sess, token: tok };
    }
    const out = r.fn(bodyText ? JSON.parse(bodyText) : {}, sess, ip);
    if (dirty) await store.set(db);
    return [200, out];
  } catch (e) {
    if (Array.isArray(e)) { if (dirty) await store.set(db).catch(() => {}); return [e[0], { error: e[1] }]; }
    console.error(e); return [500, { error: 'Erro interno' }];
  }
}
module.exports = { handle };
