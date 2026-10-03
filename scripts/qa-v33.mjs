// QA da v3.3 (encomendas, comprovante PDF/WhatsApp, teclado de quantidade) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-v33.mjs [URL]   (padrão: URL publicada)
//
// NÃO cria conta nem grava nada no banco de verdade: o banco já tem a conta do dono. O site é o publicado (GitHub Pages),
// mas as chamadas ao Supabase são respondidas por um "banco de mentira" em memória dentro do teste, montado com uma
// LEITURA (select) dos produtos/categorias/configuração reais. Câmera falsa do Chrome com vídeo de código de barras.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = (process.argv[2] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/v3.3');
fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'web/.env.supabase'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SB = env.VITE_SUPABASE_URL; const REF = new URL(SB).hostname.split('.')[0];
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; let fails = 0;
const ok = (m) => { results.push('✔ ' + m); console.log('✔', m); };
const bad = (m) => { results.push('✘ ' + m); console.log('✘', m); fails++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

// ---------- etiqueta de balança (mesma conta do app) ----------
const gtin = (body) => { let s = 0; for (let i = 0; i < body.length; i++) s += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1); return (10 - (s % 10)) % 10; };
const scaleLabel = (code, value) => { const b = '2' + String(code).padStart(5, '0') + String(value).padStart(6, '0'); return b + gtin(b); };

// ---------- dados reais (só leitura) ----------
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error('SQL ' + r.status + ' ' + (await r.text()).slice(0, 300)); return r.json();
}
if (!process.env.SUPABASE_ACCESS_TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN (só para LER os produtos).'); process.exit(1); }
const SNAP = `select (select count(*) from orders)::int orders, (select count(*) from order_items)::int order_items, (select count(*) from stock_movements)::int stock_movements, (select count(*) from customers)::int customers, (select count(*) from promotions)::int promotions, (select count(*) from auth.users)::int auth, (select count(*) from users)::int users, (select count(*) from products)::int products,
  (select count(*) from products where deleted_at is null)::int visible, (select count(*) from sales)::int sales, (select count(*) from sale_items)::int sale_items,
  (select count(*) from audit_log where user_id is null)::int audit_sem_usuario, (select count(*) from cash_sessions)::int cash, (select last_sale_number from store_settings)::int last_number`;
const [fx] = await sql(`select (select json_agg(v order by v.name) from v_products v) products, (select json_agg(c order by c.id) from categories c) cats, _settings_json() settings,
  (select auth_uid from users where username = 'rafael') owner, (select json_agg(o order by o.id) from v_orders o) orders`);
const [before] = await sql(SNAP);
console.log('banco real antes:', before);


// leitura real como dono da loja (só select; nada é gravado)
const dateLit = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error('data inválida ' + d); return `'${d}'::date`; };
async function realRpc(call) {
  const [r] = await sql(`select set_config('request.jwt.claims', json_build_object('sub', '${fx.owner}', 'role', 'authenticated')::text, true); select ${call} as r`);
  return r.r;
}
// ---------- banco de mentira (em memória) ----------
let USER = { id: 990, name: 'Teste QA', role: 'admin' };
const ts = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const NOW = Date.now(); const H = 3600e3;
const prod = (st, name) => { const p = st.products.find((x) => x.name === name); if (!p) throw new Error('sem produto ' + name); return p; };
function mockState({ open = true } = {}) {
  const products = JSON.parse(JSON.stringify(fx.products));
  const st = { products, promos: [], cats: fx.cats, settings: { ...fx.settings }, calls: [], sales: [], open, nextSale: 3245,
    customers: [
      { id: 501, name: 'Maria Souza', phone: '11987654321', doc: null, active: true, balance_cents: 0, credit_limit_cents: 20000, note: null },
      { id: 502, name: 'Mariana Alves', phone: '', doc: null, active: true, balance_cents: 1250, credit_limit_cents: 10000, note: null },
    ],
    orders: JSON.parse(JSON.stringify(fx.orders ?? [])), nextOrder: 200 };
  // promoção no Tomate LV (para o comprovante mostrar "PROMOÇÃO (de …)")
  const t = prod(st, 'Tomate LV'); const promo = Math.round(t.price_cents * 0.8 / 10) * 10 - 1;
  st.promos.push({ id: 901, product_id: t.id, promo_price_cents: promo, starts_at: ts(NOW - 5 * H), ends_at: ts(NOW + 30 * H), ended_at: null });
  Object.assign(t, { promo_id: 901, promo_price_cents: promo, promo_starts_at: ts(NOW - 5 * H), promo_ends_at: ts(NOW + 30 * H) });
  const mk = (id, o, items) => {
    const its = items.map((it, i) => { const p = it.product ? prod(st, it.product) : null;
      return { id: id * 10 + i, product_id: p?.id ?? null, name: p?.name ?? it.name, unit: p?.unit ?? it.unit ?? 'UN', qty: it.qty, line_cents: it.line_cents ?? null, icon: p?.icon ?? null, price_cents: p?.price_cents ?? null }; });
    return orderRow({ id, customer_id: null, address: '', note: '', notified_at: null, notified_count: 0, ready_at: null, concluded_at: null, canceled_at: null, cancel_reason: null,
      sale_id: null, sale_number: null, imported: false, created_by_name: 'Rafael', paid_method: null, ...o, items: its });
  };
  st.orders.push(
    mk(101, { customer_name: 'Joana Lima', phone: '11912345678', paid: false, delivery: 'a_combinar', status: 'AGUARDANDO', created_at: ts(NOW - 30 * H), note: 'Ovo caipira só chega quinta' },
      [{ product: 'Ovo caipira (cartela)', qty: 2000, line_cents: 5998 }]),
    mk(102, { customer_name: 'Seu Antônio', phone: '11933334444', paid: true, paid_method: 'pix', delivery: 'entrega', address: 'Rua das Flores, 120', status: 'AVISADA',
      created_at: ts(NOW - 50 * H), notified_at: ts(NOW - 3 * H), notified_count: 1 }, [{ product: 'Queijo', qty: 1000, line_cents: 3799 }]),
    mk(103, { customer_name: 'Dona Cida', phone: '1133221100', paid: false, delivery: 'buscar', status: 'PRONTA', created_at: ts(NOW - 26 * H), notified_at: ts(NOW - 20 * H), notified_count: 1, ready_at: ts(NOW - 2 * H) },
      [{ name: 'Mel silvestre 500 g', unit: 'UN', qty: 1000, line_cents: null }]),
  );
  return st;
}
function orderRow(o) { o.total_cents = o.items.length && o.items.every((i) => i.line_cents != null) ? o.items.reduce((a, i) => a + i.line_cents, 0) : null; return o; }
const session = { id: 1, terminal: 'QA-V3', status: 'ABERTO', opened_by: 990, opened_by_name: 'Teste QA', opened_at: '2026-10-02 19:40:00', opening_float_cents: 10000, closed_at: null };
const status = (st) => ({ store: st.settings, terminal: 'QA-V3', user: USER, held_count: 0, alerts: { expiring: [], low_stock: [] },
  orders_pending: st.orders.filter((o) => ['AGUARDANDO', 'AVISADA', 'PRONTA'].includes(o.status)).length,
  session: st.open ? { session, by_method: [{ method: 'dinheiro', expected_cents: 10000 }], movements: [], expected_total_cents: 10000, sangria_cents: 0, suprimento_cents: 0, estorno_cents: 0, opening_float_cents: 10000, sales_count: st.sales.length, sales_total_cents: st.sales.reduce((a, s) => a + s.total_cents, 0), canceled_count: 0, canceled_total_cents: 0, ticket_medio_cents: 0 } : null });
const err = (message, hint) => ({ __err: true, body: { message, hint, code: 'P0001' } });
function makeSale(st, items, payments, extra = {}) {
  const total = items.reduce((a, i) => a + i.total_cents, 0);
  const paidSum = payments.reduce((a, p) => a + p.amount_cents, 0);
  const change = Math.max(0, paidSum - total);
  const n = st.nextSale++;
  const sale = { id: 99000 + n, number: n, created_at: new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }), terminal: 'QA-V3', user_name: USER.name, status: 'FINALIZADA', imported: false,
    items, payments: payments.map((p) => ({ ...p, net_cents: p.method === 'dinheiro' ? p.amount_cents - change : p.amount_cents, change_cents: p.method === 'dinheiro' ? change : 0 })),
    subtotal_cents: total, item_discount_cents: 0, total_discount_cents: 0, discount_cents: 0, total_cents: total, change_cents: change, fiscal: { status: 'SIMULADA' }, customer_id: null, ...extra };
  st.sales.push(sale); return sale;
}
function rpcMock(st, fn, body) {
  if (fn === 'op_me') return USER;
  if (fn === 'app_status') return status(st);
  if (fn === 'order_save') {
    st.calls.push(['order_save', body]);
    const d = body.p_data;
    if (![10, 11].includes(String(d.phone).length)) return err('Telefone com DDD (10 ou 11 dígitos).', 'DADOS');
    const items = d.items.map((it, i) => { const p = it.product_id ? st.products.find((x) => x.id === it.product_id) : null;
      return { id: 9000 + i, ...it, icon: p?.icon ?? null, price_cents: p?.price_cents ?? null }; });
    if (body.p_id) { const o = st.orders.find((x) => x.id === body.p_id); Object.assign(o, d, { items }); return orderRow(o); }
    const o = orderRow({ id: st.nextOrder++, status: 'AGUARDANDO', notified_at: null, notified_count: 0, imported: false, created_at: ts(Date.now()), created_by_name: USER.name, sale_id: null, sale_number: null, ...d, items });
    st.orders.push(o); return o;
  }
  if (fn === 'order_notify') { st.calls.push(['order_notify', body.p_id]); const o = st.orders.find((x) => x.id === body.p_id);
    if (o.status === 'AGUARDANDO') o.status = 'AVISADA'; o.notified_at = ts(Date.now()); o.notified_count++; return o; }
  if (fn === 'order_ready') { st.calls.push(['order_ready', body.p_id]); const o = st.orders.find((x) => x.id === body.p_id); o.status = 'PRONTA'; o.ready_at = ts(Date.now()); return o; }
  if (fn === 'order_cancel') {
    st.calls.push(['order_cancel', body]);
    if (USER.role === 'operador' && !body.p_manager_pin) return err('Cancelar encomenda precisa do PIN do gerente.', 'PRECISA_GERENTE');
    if (body.p_manager_pin && body.p_manager_pin !== '4321') return err('PIN do gerente errado.', 'PRECISA_GERENTE');
    const o = st.orders.find((x) => x.id === body.p_id); Object.assign(o, { status: 'CANCELADA', canceled_at: ts(Date.now()), cancel_reason: body.p_reason }); return o;
  }
  if (fn === 'order_conclude') {
    st.calls.push(['order_conclude', body]);
    if (!st.open) return err('Caixa fechado. Abra o caixa para concluir a encomenda.', 'CAIXA_FECHADO');
    const o = st.orders.find((x) => x.id === body.p_id); const d = body.p_data;
    const its = o.items.map((it) => { const ov = (d.items ?? []).find((x) => x.id === it.id) ?? {}; const qty = ov.qty ?? it.qty ?? 1000; const tot = ov.line_cents ?? it.line_cents;
      return { product_id: it.product_id, name: it.name, unit: it.unit, qty, unit_price_cents: Math.round(tot * 1000 / qty), regular_price_cents: Math.round(tot * 1000 / qty), gross_cents: tot, discount_cents: 0, total_cents: tot, promotion_id: null }; });
    const total = its.reduce((a, i) => a + i.total_cents, 0);
    const pays = o.paid ? [{ method: o.paid_method, amount_cents: total }] : d.payments;
    const sale = makeSale(st, its, pays, { order: { id: o.id, customer_name: o.customer_name, phone: o.phone, delivery: o.delivery, address: o.address }, customer_id: d.customer_id ?? null });
    Object.assign(o, { status: 'CONCLUIDA', concluded_at: ts(Date.now()), sale_id: sale.id, sale_number: sale.number, paid: true, paid_method: o.paid_method ?? pays[0].method, items: o.items.map((it, i) => ({ ...it, qty: its[i].qty, line_cents: its[i].total_cents })) });
    orderRow(o); return { order: o, sale };
  }
  if (fn === 'sale_create') {
    st.calls.push(['sale_create', body]);
    const d = body.p_data ?? body;
    const items = (d.items ?? []).map((it) => {
      const p = st.products.find((x) => x.id === it.product_id); const promo = it.promotion_id ? st.promos.find((x) => x.id === it.promotion_id) : null;
      const unit = promo ? promo.promo_price_cents : p.price_cents; const gross = Math.round((unit * it.qty) / 1000);
      return { product_id: p.id, name: p.name, unit: p.unit, qty: it.qty, unit_price_cents: unit, gross_cents: gross, discount_cents: 0, total_cents: gross, promotion_id: promo?.id ?? null, regular_price_cents: p.price_cents };
    });
    const total = items.reduce((a, i) => a + i.total_cents, 0);
    return makeSale(st, items, (d.payments?.length ? d.payments : [{ method: 'dinheiro', amount_cents: total }]), { client_uuid: d.client_uuid });
  }
  if (fn === 'pin_users') return [{ id: USER.id, name: USER.name, role: USER.role }];
  if (fn === 'top_sellers' || fn === 'expiring_lots') return [];
  return undefined;
}
function filterRows(rows, sp) {
  let r = rows; const val = (v) => v.replace(/^"|"$/g, '');
  const test = (row, col, op, v) => { const x = row[col];
    if (op === 'eq') return String(x) === val(v);
    if (op === 'in') return v.replace(/^\(|\)$/g, '').split(',').map(val).includes(String(x));
    if (op === 'is') return v === 'null' ? x == null : String(x) === v;
    if (op === 'ilike') return String(x ?? '').toLowerCase().includes(val(v).replace(/\*/g, '').toLowerCase());
    return true; };
  for (const [k, v] of sp) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'or') { const parts = v.replace(/^\(|\)$/g, '').split(',').map((p) => p.split('.')); r = r.filter((row) => parts.some(([col, op, ...rest]) => test(row, col, op, rest.join('.')))); continue; }
    const [op, ...rest] = v.split('.');
    if (op === 'not') { const [op2, ...r2] = rest; r = r.filter((row) => !test(row, k, op2, r2.join('.'))); } else r = r.filter((row) => test(row, k, op, rest.join('.')));
  }
  const lim = Number(sp.get('limit')); if (lim) r = r.slice(0, lim);
  return r;
}
const external = [];
async function installMock(ctx, st, { share = false } = {}) {
  const fakeJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ sub: '00000000-0000-4000-8000-000000000990', exp: Math.floor(Date.now() / 1000) + 86400, role: 'authenticated', email: 'qa-v3@folhacaixa.app' })).toString('base64url'), 'x'].join('.');
  const user = { id: '00000000-0000-4000-8000-000000000990', aud: 'authenticated', role: 'authenticated', email: 'qa-v3@folhacaixa.app', app_metadata: { provider: 'email' }, user_metadata: { username: 'qa-v3' }, created_at: '2026-10-02T22:00:00Z' };
  const sess = { access_token: fakeJwt, token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'qa', user };
  await ctx.addInitScript(([s, share]) => {
    if (!localStorage.getItem('folha.qa')) {
      localStorage.setItem('folha.qa', '1');
      localStorage.setItem('folha.sb.auth', s); localStorage.setItem('folha.token', 'qa-token'); localStorage.setItem('folha.terminal', 'QA-V3');
    }
    if (share) { // Android: Web Share com arquivo
      navigator.canShare = (d) => !!(d && d.files && d.files.length);
      navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); window.__shared = { n: d.files.length, type: f.type, name: f.name, size: f.size, head: String.fromCharCode(...b.slice(0, 5)), text: d.text }; };
    }
  }, [JSON.stringify(sess), share]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
  await ctx.route('https://wa.me/**', (route) => { external.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>WhatsApp (teste)</h1>' }); });
  await ctx.route(`${SB}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (body, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const single = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    const body = req.postDataJSON?.() ?? {};
    if (p.startsWith('/auth/v1/user')) return json(user);
    if (p.startsWith('/auth/v1/token')) return json(sess);
    if (p.startsWith('/auth/v1/logout')) return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      if (fn === 'sale_get') { const m = st.sales.find((x) => x.id === Number(body.p_id)); if (m) return json(m); return json(await realRpc(`sale_get(${Number(body.p_id)})`)); }
      if (fn === 'report' && body.p_from) return json(await realRpc(`report(${dateLit(body.p_from)}, ${dateLit(body.p_to)})`));
      const r = rpcMock(st, fn, body);
      if (r && r.__err) return json(r.body, 400);
      if (r === undefined) { st.calls.push(['outro', fn]); return json(fn.startsWith('order_') || fn.startsWith('sale_') ? { message: 'não simulado ' + fn } : [], fn.startsWith('order_') ? 400 : 200); }
      return json(r);
    }
    if (p === '/rest/v1/v_products') { const rows = filterRows(st.products, url.searchParams); return json(single ? rows[0] : rows); }
    if (p === '/rest/v1/v_orders') { const rows = [...st.orders].sort((a, b) => b.created_at.localeCompare(a.created_at)); return json(single ? rows.find((o) => String(o.id) === url.searchParams.get('id')?.slice(3)) : rows); }
    if (p === '/rest/v1/customers') return json(filterRows(st.customers, url.searchParams));
    if (p === '/rest/v1/v_promotions') return json([]);
    if (p === '/rest/v1/v_sales_list') {
      const sp = url.searchParams; const ld = sp.getAll('local_date');
      const from = dateLit((ld.find((x) => x.startsWith('gte.')) ?? 'gte.2026-10-02').slice(4)); const to = dateLit((ld.find((x) => x.startsWith('lte.')) ?? 'lte.2026-10-02').slice(4));
      const off = Number(sp.get('offset') ?? 0) | 0; const lim = Math.min(Number(sp.get('limit') ?? 1000) | 0, 1000);
      const [r] = await sql(`select coalesce(json_agg(x), '[]') j from (select * from v_sales_list where local_date between ${from} and ${to} order by created_at desc, id desc offset ${off} limit ${lim}) x`);
      return json(r.j);
    }
    if (p === '/rest/v1/categories') return json(st.cats);
    if (p === '/rest/v1/store_settings') return json(single ? st.settings : [st.settings]);
    if (p.startsWith('/rest/v1/')) return json(single ? {} : []);
    return json({});
  });
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const launch = () => chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--lang=pt-BR'] });
async function newCtx(browser, st, { w = 1366, h = 768, mobile = false, share = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    isMobile: mobile, hasTouch: mobile, userAgent: mobile ? MOBILE_UA : undefined, serviceWorkers: 'block', acceptDownloads: true });
  await installMock(ctx, st, { share });
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => bad('erro na página: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) console.error('console', m.text()); });
  return { ctx, page };
}
const shot = async (page, name, full = false) => { await sleep(450); await page.screenshot({ path: path.join(out, name + '.png'), fullPage: full }); console.log('📸', name); };
const cartText = async (page) => (await page.locator('.cart-list').innerText().catch(() => '')).replace(/\u00a0/g, ' ');
const tileOf = (page, name) => page.locator('.tile:not(.empty)').filter({ hasText: name }).first();
const blur = (page) => page.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus(); });
const card = (page, name) => page.getByTestId('order-card').filter({ hasText: name }).first();
const txt = async (loc) => (await loc.innerText()).replace(/\u00a0/g, ' ');
const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
async function savePdf(page, click, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const f = path.join(out, name); await dl.saveAs(f); return { f, suggested: dl.suggestedFilename() };
}
const T = (n) => prod({ products: fx.products }, n);
const tomato = T('Tomate LV'); const TP = Math.round(tomato.price_cents * 0.8 / 10) * 10 - 1; // preço da promoção simulada
const alface = T('Alface');

// ---------- 1) versão ----------
{
  const sw = await (await fetch(BASE + 'sw.js', { cache: 'no-store' })).text();
  const ver = sw.match(/const VERSION = '([^']+)'/)?.[1];
  check(ver === '3.3.0', `sw.js: versão ${ver} (aparece "Atualizar agora" no app instalado)`);
}

// ---------- 2) computador 1366x768 (admin) ----------
let samplePdf;
{
  const browser = await launch();
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/encomendas'); await page.waitForSelector('[data-testid=orders]');
  const nav = page.locator('.nav');
  check(/Encomendas/.test(await nav.innerText()) && (await page.getByTestId('orders-badge').innerText()) === '3', 'menu: “📦 Encomendas” com selo 3 (pendentes)');
  const fit = await page.evaluate(() => { const n = document.querySelector('.nav'); return { page: document.documentElement.scrollWidth - innerWidth, nav: n.scrollWidth - n.clientWidth }; });
  check(fit.page <= 1 && fit.nav <= 1, `cabeçalho cabe em 1366 px com o item novo (${JSON.stringify(fit)})`);
  const pend = await txt(page.getByTestId('orders'));
  check(/Joana Lima/.test(pend) && /Seu Antônio/.test(pend) && /Dona Cida/.test(pend) && /Pendentes \(3\)/.test(await txt(page.locator('.orders-tabs'))), 'Pendentes (3): Joana (aguardando), Seu Antônio (avisado, pago), Dona Cida (pronta)');
  check(/Pago · PIX/.test(await txt(card(page, 'Seu Antônio'))) && /Rua das Flores/.test(await txt(card(page, 'Seu Antônio'))) && /avisado em/.test(await txt(card(page, 'Seu Antônio'))), 'cartão mostra Pago · Pix, entrega com endereço e “avisado em”');
  await shot(page, 'desk-01-encomendas-pendentes');
  await page.locator('.orders-tabs button', { hasText: 'Concluídas' }).click(); await sleep(300);
  const conc = await txt(page.getByTestId('orders'));
  // nomes vêm do banco (não ficam escritos no repositório público)
  const imp = fx.orders.filter((o) => o.imported); const unpaid = imp.find((o) => !o.paid);
  check(imp.length === 3 && imp.every((o) => conc.includes(o.customer_name)) && (await page.getByTestId('order-card').count()) === 3, `Concluídas: as ${imp.length} encomendas importadas do sistema antigo`);
  const uc = await txt(card(page, unpaid.customer_name));
  check(/Não pago/.test(uc) && uc.includes(brl(unpaid.total_cents)) && /NÃO PAGO no sistema antigo/.test(uc) && await card(page, unpaid.customer_name).getByTestId('unpaid-flag').count() === 1,
    `a não paga (${unpaid.items[0].name} ${brl(unpaid.total_cents)}): selo “Não pago” e a observação (sem fiado automático)`);
  check(/Sistema antigo/.test(conc) && await page.getByTestId('order-conclude').count() === 0, 'importadas: selo “Sistema antigo”, sem botões de ação');
  await shot(page, 'desk-02-encomendas-concluidas-importadas');
  await page.locator('.orders-tabs button', { hasText: 'Pendentes' }).click();

  // nova encomenda
  await page.getByTestId('order-new').click(); await page.waitForSelector('[data-testid=order-save]');
  await page.getByTestId('order-name').fill('Mar'); await page.waitForSelector('.ac-list');
  check(/Maria Souza/.test(await page.locator('.ac-list').innerText()) && /Mariana Alves/.test(await page.locator('.ac-list').innerText()), 'nome: sugestões dos clientes cadastrados (Maria Souza, Mariana Alves)');
  await page.locator('.ac-list button', { hasText: 'Maria Souza' }).click();
  check(await page.getByTestId('order-phone').inputValue() === '(11) 98765-4321', 'escolheu Maria Souza: telefone preenchido com máscara (11) 98765-4321');
  const ps = page.getByPlaceholder('Produto do cadastro (nome, código ou 📷)');
  await ps.fill('tomate lv'); await ps.press('Enter');
  const q0 = page.getByTestId('order-items').getByLabel('Quantidade').first();
  await q0.fill('1,5'); await sleep(150);
  await page.getByTestId('order-free').fill('Queijo da serra'); await page.getByTestId('order-free-add').click();
  await page.getByLabel('Valor de Queijo da serra').fill('42,00'); await sleep(100);
  await ps.fill('alface'); await ps.press('Enter');
  const q2 = page.getByTestId('order-items').getByLabel('Quantidade').nth(2); await q2.fill('3');
  await page.getByRole('button', { name: 'Entrega', exact: true }).click(); await page.getByTestId('order-address').fill('Rua Ipê, 45 – fundos');
  await page.getByPlaceholder('ex.: queijo bem curado, chega quinta').fill('Queijo curado; ligar antes');
  const tomLine = Math.round(TP * 1500 / 1000); const total1 = tomLine + 4200 + alface.price_cents * 3;
  const tot = (await page.getByTestId('order-total').innerText()).replace(/\u00a0/g, ' ');
  check(tot === brl(total1), `itens: 1,5 kg Tomate LV (${brl(tomLine)} pelo preço de hoje, em promoção) + Queijo da serra R$ 42,00 (livre) + 3 Alface = ${tot}`);
  await shot(page, 'desk-03-nova-encomenda');
  await page.getByTestId('order-phone').fill('11 9876'); await page.getByTestId('order-save').click();
  check(/Telefone com DDD/.test(await page.locator('.modal .err').innerText()), 'telefone incompleto: não salva e avisa');
  await page.getByTestId('order-phone').fill('11987654321');
  await page.getByTestId('order-save').click(); await page.waitForSelector('[data-testid=order-save]', { state: 'detached' });
  const sv = st.calls.find((c) => c[0] === 'order_save')?.[1]?.p_data;
  check(sv && sv.phone === '11987654321' && sv.customer_id === 501 && sv.delivery === 'entrega' && sv.address === 'Rua Ipê, 45 – fundos' && !sv.paid
    && sv.items[0].qty === 1500 && sv.items[0].line_cents === tomLine && sv.items[1].product_id === null && sv.items[1].line_cents === 4200 && sv.items[2].qty === 3000,
    `order_save: telefone só dígitos, cliente ligado, entrega, itens em milésimos (${JSON.stringify(sv?.items)})`);
  await page.waitForFunction(() => document.querySelector('[data-testid=orders-badge]')?.textContent === '4');
  ok('selo do menu passou para 4');

  // Chegou → WhatsApp
  await card(page, 'Maria Souza').getByTestId('order-arrived').click(); await page.waitForSelector('[data-testid=notify-preview]');
  const msg = await page.getByTestId('notify-text').inputValue();
  const expMsg = `Olá Maria! Sua encomenda de 1,500 kg de Tomate LV, 1 un de Queijo da serra e 3 un de Alface chegou no Hortifruti Frutos da Roça 🥬.\nCombinamos a entrega em Rua Ipê, 45 – fundos?\nTotal ${brl(total1)} (a pagar).`;
  check(msg === expMsg, `mensagem pronta: ${JSON.stringify(msg)}`);
  const href = await page.getByTestId('notify-open').getAttribute('href');
  check(href === `https://wa.me/5511987654321?text=${encodeURIComponent(expMsg)}`, 'link wa.me/55 + telefone com o texto (o app só abre; quem envia é o Rafael)');
  await shot(page, 'desk-04-aviso-whatsapp');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('notify-open').click()]);
  await popup.waitForLoadState().catch(() => {}); await popup.close();
  await page.waitForSelector('[data-testid=notify-preview]', { state: 'detached' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=order-card]')].some((c) => /Maria Souza/.test(c.textContent) && /avisado em/.test(c.textContent) && /Chegou · avisado/.test(c.textContent)));
  check(st.calls.filter((c) => c[0] === 'order_notify').length === 1 && external.length === 1 && external[0].startsWith('https://wa.me/5511987654321?text='), 'tocou: abriu o WhatsApp (1 aba wa.me), marcou “Chegou · avisado” e gravou “avisado em”');

  // Concluir sem pagamento → pergunta a forma
  await card(page, 'Maria Souza').getByTestId('order-conclude').click(); await page.waitForSelector('[data-testid=conclude-pay]');
  check(await page.getByTestId('conclude-confirm').isDisabled(), 'concluir não pago: botão travado até escolher a forma de pagamento');
  check((await page.locator('[data-testid=conclude-pay] .methods button').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim()).join('|').match(/Dinheiro.*PIX.*Débito.*Crédito.*Fiado/) != null, 'formas: Dinheiro, Pix, Débito, Crédito, Fiado');
  await shot(page, 'desk-05-encomenda-forma-de-pagamento');
  await page.getByTestId('pay-dinheiro').click();
  await page.locator('[data-testid=conclude-pay] input').first().fill('100,00'); await sleep(200);
  const trocoExp = 10000 - total1;
  check((await txt(page.locator('.modal .restante.troco'))).includes(brl(trocoExp)), `dinheiro R$ 100,00: troco ${brl(trocoExp)}`);
  check(/Pagamento recebido/.test(await page.getByTestId('conclude-confirm').innerText()), 'botão “✓ Pagamento recebido · gerar comprovante”');
  await shot(page, 'desk-06-encomenda-pagamento-recebido');
  await page.getByTestId('conclude-confirm').click();
  await page.waitForSelector('.modal >> text=Encomenda concluída · venda nº 3245');
  const cc = st.calls.find((c) => c[0] === 'order_conclude')?.[1];
  check(cc && cc.p_terminal === 'QA-V3' && cc.p_data.payments[0].method === 'dinheiro' && cc.p_data.payments[0].amount_cents === 10000 && cc.p_data.items.length === 3, 'order_conclude: terminal, dinheiro R$ 100,00, itens conferidos → virou a venda nº 3245 (estoque/caixa no banco)');
  const done = await txt(page.locator('.modal')); fs.writeFileSync('/tmp/done.txt', done);
  check(done.includes(brl(total1)) && done.includes(brl(trocoExp)) && /Sem comprovante/.test(done), 'depois de concluir: total, troco e opções de comprovante');
  await shot(page, 'desk-07-encomenda-concluida-comprovante');
  const p1 = await savePdf(page, () => page.getByTestId('comp-pdf').click(), 'comprovante-encomenda-3245.pdf');
  const t1 = pdfText(p1.f); fs.writeFileSync('/tmp/t1.txt', t1);
  check(p1.suggested === 'comprovante-3245.pdf' && /HORTIFRUTI FRUTOS DA RO/i.test(t1) && /Encomenda nº \d+ · Maria Souza/.test(t1) && /Maria Souza/.test(t1) && /Queijo da serra/.test(t1) && /TROCO/i.test(t1), `PDF da encomenda (download no PC): ${p1.suggested}`);
  await page.getByTestId('comp-wa').click(); await page.waitForSelector('[data-testid=comp-wa-text]');
  check(await page.getByTestId('comp-phone').inputValue() === '(11) 98765-4321', 'WhatsApp do comprovante: telefone já vem da encomenda');
  const wt = (await page.getByTestId('comp-wa-text').innerText()).replace(/\u00a0/g, ' '); fs.writeFileSync('/tmp/wt.txt', wt);
  check(/Comprovante — Hortifruti Frutos da Roça/.test(wt) && /Venda nº 3245/.test(wt) && /Encomenda de Maria Souza/.test(wt) && wt.includes(`*Total: ${brl(total1)}*`) && /troco/.test(wt), 'texto do comprovante para WhatsApp');
  check((await page.getByTestId('comp-wa-open').getAttribute('href'))?.startsWith('https://wa.me/5511987654321?text=%F0%9F%A7%BE'), 'link “Abrir no WhatsApp” com o comprovante');
  await shot(page, 'desk-08-comprovante-whatsapp');
  await page.getByTestId('comp-none').click(); await page.waitForSelector('.modal', { state: 'detached' });
  await page.locator('.orders-tabs button', { hasText: 'Concluídas' }).click(); await sleep(300);
  check(/venda nº 3245/.test(await txt(card(page, 'Maria Souza'))), 'Concluídas: Maria Souza com “venda nº 3245” e botão 🧾 Comprovante');
  await page.locator('.orders-tabs button', { hasText: 'Pendentes' }).click(); await sleep(200);

  // Pronta / já pago
  await card(page, 'Seu Antônio').getByTestId('order-ready').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=order-card]')].some((c) => /Seu Antônio/.test(c.textContent) && /Pronta/.test(c.textContent)));
  ok('📦 Pronta: Seu Antônio passou para Pronta');
  await card(page, 'Seu Antônio').getByTestId('order-conclude').click(); await page.waitForSelector('[data-testid=conclude-paid]');
  check(/Já pago no PIX: R\$ 37,99/.test(await txt(page.getByTestId('conclude-paid'))) && /Entregar e gerar comprovante/.test(await page.getByTestId('conclude-confirm').innerText()), 'já pago: não pergunta forma (Pix), botão “Entregar e gerar comprovante”');
  await page.getByTestId('conclude-confirm').click(); await page.waitForSelector('.modal >> text=venda nº 3246');
  const cc2 = st.calls.filter((c) => c[0] === 'order_conclude')[1]?.[1];
  check(cc2 && cc2.p_data.payments.length === 0, 'pago antes: conclui sem mandar pagamento (o banco usa o Pix registrado)');
  await page.keyboard.press('Enter'); await page.waitForSelector('.modal', { state: 'detached' });
  ok('Enter = “Sem comprovante · próximo”');
  // valor a definir + cancelar (admin)
  await card(page, 'Dona Cida').getByTestId('order-conclude').click(); await page.waitForSelector('[data-testid=conclude-pay]');
  await page.getByTestId('pay-pix').click(); await page.getByTestId('conclude-confirm').click();
  check(/Preencha quantidade e valor/.test(await page.locator('.modal .err').innerText()), 'item sem valor (Mel): pede o valor antes de concluir');
  await page.keyboard.press('Escape'); await sleep(300);
  await card(page, 'Dona Cida').getByRole('button', { name: 'Cancelar' }).click();
  await page.getByTestId('order-cancel-confirm').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=order-card]')].some((c) => /Dona Cida/.test(c.textContent)));
  check(st.calls.find((c) => c[0] === 'order_cancel')?.[1]?.p_manager_pin == null, 'admin cancela direto (sem PIN)');
  check((await page.locator('.orders-tabs').innerText()).includes('Canceladas (1)') && (await page.getByTestId('orders-badge').innerText()) === '1', 'Canceladas (1); selo 1 pendente (Joana)');

  // ---- venda: teclado de quantidade ----
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await tileOf(page, 'Tomate LV').click(); await page.waitForSelector('.pending-bar');
  await page.getByTestId('pending-type').click(); await page.waitForSelector('[data-testid=qtypad]');
  await page.keyboard.type('350', { delay: 40 }); await sleep(200);
  const prev = await txt(page.getByTestId('qpad-preview'));
  check((await page.getByTestId('qpad-hint').innerText()) === '350 g = 0,350 kg' && (await page.locator('.qpad-display .u').innerText()) === 'g' && prev === `0,350 kg × ${brl(TP)}/kg (PROMO) = ${brl(Math.round(TP * 350 / 1000))}`, `digitou 350 → mostra “350 g”, “350 g = 0,350 kg” e prévia “${prev}”`);
  check(await page.locator('.qpad-in').getAttribute('inputmode') === 'decimal', 'campo com inputmode=decimal (teclado numérico do Android)');
  await shot(page, 'desk-09-quantidade-kg-350g');
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  await page.keyboard.type('1,5'); await sleep(150);
  check((await page.getByTestId('qpad-hint').innerText()) === '1,500 kg', 'digitou 1,5 → 1,500 kg');
  await page.locator('.qpad-quick button', { hasText: '+250 g' }).click(); await sleep(100);
  check((await txt(page.getByTestId('qpad-preview'))).startsWith('1,750 kg'), '+250 g → 1,750 kg');
  await page.getByTestId('qpad-valor').click(); await page.keyboard.type('500'); await sleep(150);
  const kgV = Math.round(500 * 1000 / TP);
  const hv = (await page.getByTestId('qpad-hint').innerText()).replace(/\u00a0/g, ' ');
  check(hv === `R$ 5,00 = ${(kgV / 1000).toFixed(3).replace('.', ',')} kg`, `modo R$: 500 → “${hv}”`);
  await shot(page, 'desk-10-quantidade-valor-em-reais');
  await page.keyboard.press('Enter'); await page.waitForSelector('[data-testid=qtypad]', { state: 'detached' });
  check((await cartText(page)).includes((kgV / 1000).toFixed(3).replace('.', ',')), `sacola: Tomate LV ${(kgV / 1000).toFixed(3)} kg (R$ 5,00)`);
  // balança/peso no campo continua igual
  await blur(page); await page.keyboard.type('0,800', { delay: 20 }); await page.keyboard.press('Enter'); await tileOf(page, 'Banana prata').click(); await sleep(400);
  check(/0,800 kg/.test(await cartText(page)) && /Banana prata/.test(await cartText(page)), 'campo de peso (balança) do PC continua: 0,800 + Enter + Banana prata');
  // leitor USB
  await blur(page); await page.keyboard.type('9788568014325', { delay: 6 }); await page.keyboard.press('Enter'); await sleep(500);
  check(/Livro/.test(await cartText(page)), 'leitor USB (EAN 9788568014325) continua adicionando o produto');
  // unidade: toque na linha, − / + e 1·2·3·6·12
  await tileOf(page, 'Alface').click(); await sleep(300);
  await page.locator('.cart-line', { hasText: 'Alface' }).click(); await page.waitForSelector('[data-testid=qtypad]');
  await page.locator('.qpad-quick button', { hasText: /^6$/ }).click(); await page.getByLabel('Mais um').click(); await sleep(100);
  check((await page.locator('.qpad-in').inputValue()) === '7' && (await txt(page.getByTestId('qpad-preview'))).endsWith(brl(alface.price_cents * 7)), 'editar linha (toque): 6 + “+” = 7 un, prévia do valor');
  await shot(page, 'desk-11-editar-linha-unidades');
  await page.getByLabel('Menos um').click(); await page.getByTestId('line-save').click(); await sleep(300);
  check(/6 un/.test(await cartText(page)), 'salvou 6 un de Alface');
  // tirar o Livro (R$ 100) para a venda ficar realista
  await page.locator('.cart-line', { hasText: 'Livro' }).click(); await page.getByRole('button', { name: 'Tirar da sacola' }).click(); await sleep(300);
  // pagar → comprovante opcional
  await page.keyboard.press('F10'); await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'Dinheiro' }).click();
  await page.locator('.bills .btn').last().click().catch(() => {});
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.waitForSelector('[data-testid=comp-none]');
  const sc = st.calls.filter((c) => c[0] === 'sale_create').pop()?.[1]?.p_data;
  check(sc && sc.items.find((i) => i.product_id === tomato.id)?.qty === kgV && sc.items.find((i) => i.product_id === alface.id)?.qty === 6000, 'venda enviada com as quantidades certas (milésimos)');
  await sleep(400); const act = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)); console.log('foco:', act);
  check(/comp-none/.test(act ?? ''), '“Sem comprovante · próximo (Enter)” já focado (padrão rápido)');
  await shot(page, 'desk-12-venda-comprovante-opcional');
  samplePdf = await savePdf(page, () => page.getByTestId('comp-pdf').click(), 'comprovante-exemplo-venda.pdf');
  const t2 = pdfText(samplePdf.f);
  check(/PROMO/.test(t2) && /Tomate LV/.test(t2) && /Alface/.test(t2) && /TROCO/i.test(t2) && /Dinheiro/.test(t2) && /N.O . DOCUMENTO FISCAL/.test(t2), 'PDF da venda: cabeçalho, itens, PROMOÇÃO, total, dinheiro, troco, “não é documento fiscal”');
  await page.getByTestId('comp-none').click(); await page.waitForSelector('[data-testid=comp-none]', { state: 'detached' });
  check(!(await cartText(page)).trim() || !/Alface/.test(await cartText(page)), 'sacola limpa para o próximo cliente');
  // histórico: venda importada
  await page.goto(BASE + '#/vendas'); await page.waitForSelector('input[aria-label="De"]');
  await page.getByLabel('De', { exact: true }).fill('2026-09-15'); await page.getByLabel('Até', { exact: true }).fill('2026-09-15');
  await page.waitForSelector('table tbody tr >> text=Sistema antigo');
  await page.locator('table tbody tr').first().getByRole('button', { name: /Comprovante/ }).click(); await page.waitForSelector('[data-testid=comp-pdf]');
  await shot(page, 'desk-13-historico-comprovante-venda-importada');
  const p3 = await savePdf(page, () => page.getByTestId('comp-pdf').click(), 'comprovante-venda-importada.pdf');
  const t3 = pdfText(p3.f);
  check(/importada/i.test(t3), 'venda importada (histórico): PDF sai com a nota “importada do sistema antigo”');
  await ctx.close(); await browser.close();
}

// ---------- 3) celular 412x915 (Android, Web Share) ----------
{
  const browser = await launch();
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { w: 412, h: 915, mobile: true, share: true });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  const moreBtn = page.locator('.bottom-nav button', { hasText: 'Mais' });
  check((await moreBtn.innerText()).includes('3'), 'celular: “Mais” com selo 3');
  await moreBtn.click(); await page.locator('.sheet-grid button, .bottom-sheet button', { hasText: 'Encomendas' }).first().click().catch(async () => { await page.getByRole('button', { name: /Encomendas/ }).last().click(); });
  await page.waitForSelector('[data-testid=orders]');
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(ov <= 1, `celular: Encomendas pelo “Mais”, sem rolagem lateral (${ov}px)`);
  await shot(page, 'mob-01-encomendas');
  await page.getByTestId('order-new').click(); await page.waitForSelector('[data-testid=order-save]');
  await page.getByTestId('order-name').fill('Pedro'); await page.getByTestId('order-phone').fill('21999887766');
  check(await page.getByTestId('order-phone').inputValue() === '(21) 99988-7766', 'celular: máscara do telefone');
  const ps = page.getByPlaceholder('Produto do cadastro (nome, código ou 📷)'); await ps.fill('banana prata'); await ps.press('Enter');
  await page.getByTestId('order-items').getByLabel('Quantidade').first().fill('2');
  await page.getByTestId('order-paid-yes').click();
  await page.waitForTimeout(200);
  check(/2 = 2 kg|kg/.test(await page.getByTestId('order-items').innerText()), 'celular: 2 → 2 kg no item');
  await shot(page, 'mob-02-nova-encomenda');
  await page.getByTestId('order-items').scrollIntoViewIfNeeded();
  await shot(page, 'mob-02b-nova-encomenda-itens');
  await page.getByTestId('order-save').click(); await page.waitForSelector('[data-testid=order-save]', { state: 'detached' });
  const sv = st.calls.find((c) => c[0] === 'order_save')?.[1]?.p_data;
  check(sv?.paid === true && sv.paid_method === 'pix' && sv.items[0].qty === 2000, 'celular: encomenda paga (Pix) com 2 kg salva');
  await card(page, 'Joana Lima').getByTestId('order-arrived').click(); await page.waitForSelector('[data-testid=notify-preview]');
  check(/Você vai vir buscar ou prefere entrega\?/.test(await page.getByTestId('notify-text').inputValue()) && /Total R\$ 59,98 \(a pagar\)/.test(await page.getByTestId('notify-text').inputValue()), 'Joana (a combinar): pergunta “vai vir buscar ou prefere entrega?” e Total R$ 59,98 (a pagar)');
  await shot(page, 'mob-03-aviso-whatsapp');
  await page.getByTestId('notify-mark').click(); await page.waitForSelector('[data-testid=notify-preview]', { state: 'detached' });
  await card(page, 'Joana Lima').getByTestId('order-conclude').click(); await page.waitForSelector('[data-testid=conclude-pay]');
  await page.getByTestId('pay-pix').click(); await sleep(200);
  await page.waitForSelector('.toast', { state: 'detached', timeout: 15000 }).catch(() => {});
  const fb = await page.getByTestId('conclude-confirm').boundingBox();
  check(fb && fb.x >= 0 && fb.x + fb.width <= 412 + 1, `celular: botão “Pagamento recebido” cabe na tela (${fb && Math.round(fb.x)}–${fb && Math.round(fb.x + fb.width)} px)`);
  await shot(page, 'mob-04-encomenda-forma-de-pagamento');
  await page.getByTestId('conclude-confirm').click(); await page.waitForSelector('[data-testid=comp-pdf]');
  await shot(page, 'mob-05-encomenda-concluida-comprovante');
  await page.getByTestId('comp-pdf').click();
  await page.waitForFunction(() => window.__shared, null, { timeout: 15000 });
  const sh = await page.evaluate(() => window.__shared);
  check(sh.n === 1 && sh.type === 'application/pdf' && sh.head === '%PDF-' && /^comprovante-\d+\.pdf$/.test(sh.name), `Android: PDF vai pelo “Compartilhar” (arquivo ${sh.name}, ${sh.size} bytes) — dá para escolher o WhatsApp`);
  await page.getByTestId('comp-wa').click(); await sleep(300);
  await shot(page, 'mob-06-comprovante-whatsapp');
  await page.getByTestId('comp-none').click();
  // venda: teclado grande
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await page.waitForSelector('.toast', { state: 'detached', timeout: 15000 }).catch(() => {});
  await tileOf(page, 'Tomate LV').click(); await page.waitForSelector('[data-testid=qtypad]');
  for (const k of ['3', '5', '0']) await page.locator('.qpad-keys button', { hasText: new RegExp(`^${k}$`) }).click();
  check((await txt(page.getByTestId('qpad-preview'))) === `0,350 kg × ${brl(TP)}/kg (PROMO) = ${brl(Math.round(TP * 350 / 1000))}`, 'celular: teclado grande 3·5·0 → 0,350 kg com prévia do valor');
  await shot(page, 'mob-07-quantidade-kg-teclado');
  await page.getByTestId('qpad-valor').click();
  for (const k of ['5', ',', '0', '0']) await page.locator('.qpad-keys button', { hasText: new RegExp(`^${k === ',' ? ',' : k}$`) }).click();
  await shot(page, 'mob-08-quantidade-valor-em-reais');
  await page.getByTestId('qpad-ok').click(); await sleep(300);
  await tileOf(page, 'Alface').click(); await sleep(300);
  await page.getByLabel('Ver sacola').click(); await sleep(300);
  await page.locator('.cart-line', { hasText: 'Alface' }).click(); await page.waitForSelector('[data-testid=qtypad]');
  await page.locator('.qpad-quick button', { hasText: /^12$/ }).click();
  await shot(page, 'mob-09-quantidade-unidades');
  await page.getByTestId('line-save').click(); await sleep(300);
  check(/12 un/.test(await cartText(page)), 'celular: Alface 12 un pelo atalho “12”');
  await ctx.close(); await browser.close();
}

// ---------- 4) operador com caixa fechado ----------
{
  USER = { id: 991, name: 'Operador QA', role: 'operador' };
  const browser = await launch();
  const st = mockState({ open: false });
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/encomendas'); await page.waitForSelector('[data-testid=orders]');
  check(/Encomendas/.test(await page.locator('.nav').innerText()), 'operador: vê o menu Encomendas');
  await card(page, 'Seu Antônio').getByTestId('order-conclude').click(); await page.waitForSelector('[data-testid=conclude-paid]');
  check(/Caixa fechado/.test(await page.locator('.modal').innerText()) && await page.getByTestId('conclude-confirm').isDisabled(), 'caixa fechado: aviso claro e botão de concluir travado');
  await shot(page, 'desk-14-concluir-caixa-fechado');
  await page.keyboard.press('Escape'); await sleep(300);
  await card(page, 'Joana Lima').getByRole('button', { name: 'Cancelar' }).click();
  await page.getByTestId('order-cancel-confirm').click();
  await page.waitForSelector('.pin-dots');
  ok('operador: cancelar pede o PIN do gerente');
  await page.keyboard.type('4321'); await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=order-card]')].some((c) => /Joana Lima/.test(c.textContent)));
  check(st.calls.filter((c) => c[0] === 'order_cancel').pop()?.[1]?.p_manager_pin === '4321', 'com o PIN do gerente: cancelada');
  await ctx.close(); await browser.close();
}

// ---------- PDF de exemplo → PNG ----------
{
  execFileSync('pdftoppm', ['-png', '-r', '150', '-singlefile', samplePdf.f, path.join(out, 'comprovante-exemplo-venda')]);
  check(fs.existsSync(path.join(out, 'comprovante-exemplo-venda.png')), 'PDF de exemplo renderizado: comprovante-exemplo-venda.png');
}

// ---------- banco: RLS das encomendas ----------
{
  const pol = await sql(`select tablename, policyname, cmd from pg_policies where tablename in ('orders','order_items')`);
  const [rls] = await sql(`select bool_and(relrowsecurity) r from pg_class where relname in ('orders','order_items') and relkind = 'r'`);
  const [gr] = await sql(`select has_table_privilege('authenticated','orders','INSERT') i1, has_table_privilege('authenticated','orders','UPDATE') u1, has_table_privilege('authenticated','order_items','INSERT') i2, has_table_privilege('anon','orders','SELECT') a1, has_function_privilege('anon','order_conclude(text,text,int,jsonb)','EXECUTE') af`).catch(async () => sql(`select has_table_privilege('authenticated','orders','INSERT') i1, has_table_privilege('authenticated','orders','UPDATE') u1, has_table_privilege('authenticated','order_items','INSERT') i2, has_table_privilege('anon','orders','SELECT') a1, false af`));
  check(rls.r && pol.length >= 2 && pol.every((p) => p.cmd === 'SELECT') && !gr.i1 && !gr.u1 && !gr.i2 && !gr.a1 && !gr.af, `orders/order_items: RLS ligado, só leitura direta (${pol.map((p) => p.tablename + ':' + p.cmd).join(', ')}); gravar só pelas funções order_*`);
}

// ---------- o banco de verdade não mudou ----------
const [after] = await sql(SNAP);
const [mine] = await sql(`select coalesce(json_agg(json_build_object('id', id, 'action', action, 'user_id', user_id)), '[]') j from audit_log where created_at > now() - interval '20 minutes' and user_id is not null`);
if (mine.j.length) ok(`ações reais de usuários no app durante o QA (não são do teste): ${JSON.stringify(mine.j)}`);
const strip = (o) => ({ ...o, sales: undefined, last_number: undefined, sale_items: undefined, stock_movements: undefined });
check(JSON.stringify(strip(after)) === JSON.stringify(strip(before)) && after.sales >= before.sales, `banco real intacto durante o QA (fora vendas reais do Rafael): ${JSON.stringify(after)}`);

fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA v3.3 em ${BASE}\n${new Date().toString()}\n(gravações respondidas por banco de mentira em memória; banco real só lido)\n\n${results.join('\n')}\n\n${fails ? fails + ' FALHA(S)' : 'TUDO OK'}\n`);
console.log(fails ? `\n${fails} falha(s)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
