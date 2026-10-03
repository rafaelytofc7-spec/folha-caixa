// QA da v3.4 (apagar venda só admin + modo do teclado de quantidade travado) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-v34.mjs [URL]   (padrão: URL publicada)
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
const out = path.join(root, 'docs/prints/v3.4');
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
const SNAP = `select (select count(*) from sales where status = 'EXCLUIDA')::int excluidas, (select count(*) from cash_movements)::int cash_moves, (select count(*) from customer_ledger)::int ledger, (select sum(stock_qty) from products)::int stock_sum, (select sum(total_cents) from sales where status = 'FINALIZADA')::bigint total_finalizadas, (select count(*) from orders)::int orders, (select count(*) from order_items)::int order_items, (select count(*) from stock_movements)::int stock_movements, (select count(*) from customers)::int customers, (select count(*) from promotions)::int promotions, (select count(*) from auth.users)::int auth, (select count(*) from users)::int users, (select count(*) from products)::int products,
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
  const st = { products, promos: [], cats: fx.cats, settings: { ...fx.settings }, calls: [], sales: [], open, nextSale: 3246,
    customers: [
      { id: 501, name: 'Maria Souza', phone: '11987654321', doc: null, active: true, balance_cents: 0, credit_limit_cents: 20000, note: null },
      { id: 502, name: 'Mariana Alves', phone: '', doc: null, active: true, balance_cents: 1250, credit_limit_cents: 10000, note: null },
    ],
    orders: JSON.parse(JSON.stringify(fx.orders ?? [])), nextOrder: 200, over: {} };
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
      if (fn === 'sale_get') { const id = Number(body.p_id); const m = st.sales.find((x) => x.id === id); if (m) return json(m);
        const r = await realRpc(`sale_get(${id})`); return json({ ...r, ...(st.over[id] ?? {}) }); }
      if (fn === 'sale_delete') {
        st.calls.push(['sale_delete', body]);
        if (USER.role !== 'admin') return json({ message: 'Só o administrador pode apagar venda.', hint: 'PROIBIDO', code: 'P0001' }, 400);
        if (String(body.p_reason ?? '').trim().length < 3) return json({ message: 'Escreva o motivo para apagar a venda.', hint: 'DADOS', code: 'P0001' }, 400);
        const id = Number(body.p_id); let s = st.sales.find((x) => x.id === id);
        if (!s) s = { ...(await realRpc(`sale_get(${id})`)), ...(st.over[id] ?? {}) };
        if (s.status === 'EXCLUIDA') return json({ message: 'Esta venda já foi apagada.', hint: 'CONFLITO', code: 'P0001' }, 400);
        if (body.p_confirm_number !== s.number) return json({ message: `Para confirmar, digite o número da venda: ${s.number}.`, hint: 'CONFIRMAR', code: 'P0001' }, 400);
        const patch = { status: 'EXCLUIDA', deleted_at: new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }), deleted_by_name: USER.name, delete_reason: body.p_reason.trim(), deleted_prev_status: s.status };
        const local = st.sales.find((x) => x.id === id); if (local) Object.assign(local, patch); else st.over[id] = { ...(st.over[id] ?? {}), ...patch };
        return json({ ...s, ...patch, effects: {} });
      }
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
      const f = from.slice(1, 11); const t = to.slice(1, 11);
      const mine = off ? [] : st.sales.filter((s) => s.created_at.slice(0, 10) >= f && s.created_at.slice(0, 10) <= t).map((s) => ({ id: s.id, number: s.number, status: s.status, total_cents: s.total_cents,
        created_at: s.created_at, terminal: s.terminal, offline: false, local_date: s.created_at.slice(0, 10), user_name: s.user_name, customer_name: s.customer_name ?? null,
        methods: s.payments.map((p) => p.method).join('+'), items_count: s.items.length, imported: false, deleted_at: s.deleted_at ?? null, delete_reason: s.delete_reason ?? null, deleted_by_name: s.deleted_by_name ?? null }));
      const rows = [...mine, ...(st.onlyMine ? [] : r.j).map((x) => ({ ...x, ...(st.over[x.id] ?? {}) }))].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(rows);
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

const banana = T('Banana prata');
const nowLocal = (ms = Date.now()) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const line = (st, name, qty) => { const p = prod(st, name); const tot = Math.round(p.price_cents * qty / 1000);
  return { product_id: p.id, name: p.name, unit: p.unit, qty, unit_price_cents: p.price_cents, regular_price_cents: p.price_cents, gross_cents: tot, discount_cents: 0, total_cents: tot, promotion_id: null }; };
// vendas de teste (em memória): caixa aberto, fiado, encomenda, caixa fechado (ontem) e uma já apagada
function seedSales(st) {
  st.onlyMine = true; // só as vendas de teste na lista (o dia de hoje/ontem também tem vendas reais)
  const at = (hm) => `${today} ${hm}:00`;
  const a = makeSale(st, [line(st, 'Cebola', 1500), line(st, 'Alface', 2000)], [{ method: 'dinheiro', amount_cents: 2000 }], { session_status: 'ABERTO', created_at: at('00:01') });
  const b = makeSale(st, [line(st, 'Batata', 1000)], [{ method: 'fiado', amount_cents: line(st, 'Batata', 1000).total_cents }], { session_status: 'ABERTO', customer_id: 501, customer_name: 'Maria Souza', created_at: at('00:02') });
  const c = makeSale(st, [line(st, 'Queijo', 1000)], [{ method: 'pix', amount_cents: line(st, 'Queijo', 1000).total_cents }], { session_status: 'ABERTO', order: { id: 101, customer_name: 'Joana Lima', phone: '11912345678', delivery: 'buscar', address: '' }, created_at: at('00:03') });
  const d = makeSale(st, [line(st, 'Cenoura', 2000)], [{ method: 'pix', amount_cents: line(st, 'Cenoura', 2000).total_cents }], { session_status: 'FECHADO', created_at: `${yesterday} 18:00:00` });
  const e = makeSale(st, [line(st, 'Laranja', 3000)], [{ method: 'dinheiro', amount_cents: 1000 }], { session_status: 'ABERTO', created_at: at('00:04') });
  Object.assign(e, { status: 'EXCLUIDA', deleted_at: nowLocal(Date.now() - 10 * 60e3), deleted_by_name: 'Rafael', delete_reason: 'venda de teste', deleted_prev_status: 'FINALIZADA' });
  return { a, b, c, d, e };
}
const rowOf = (page, n) => page.locator(`table tbody tr:has(td:first-child b:text-is("${n}"))`);
const today = nowLocal().slice(0, 10); const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
async function openRange(page, from, to) {
  await page.goto(BASE + '#/vendas'); await page.waitForSelector('input[aria-label="De"]');
  await page.getByLabel('De', { exact: true }).fill(from); await page.getByLabel('Até', { exact: true }).fill(to); await sleep(1200);
}

// ---------- 1) versão ----------
{
  const sw = await (await fetch(BASE + 'sw.js', { cache: 'no-store' })).text();
  const ver = sw.match(/const VERSION = '([^']+)'/)?.[1];
  check(ver === '3.4.0', `sw.js: versão ${ver} (aparece "Atualizar agora" no app instalado)`);
}

// ---------- 2) computador: administrador apaga ----------
{
  USER = { id: 990, name: 'Teste QA', role: 'admin' };
  const browser = await launch(); const st = mockState(); const S = seedSales(st);
  const { ctx, page } = await newCtx(browser, st);
  await openRange(page, yesterday, today);
  await page.waitForSelector(`table tbody tr >> text=${S.a.number}`);
  await page.waitForFunction(() => (document.querySelector('.big-tag')?.textContent ?? '').startsWith('4 vendas'), null, { timeout: 15000 }).catch(() => {});
  check(await page.getByTestId('sale-delete').count() === 4 && await rowOf(page, S.e.number).count() === 0, 'admin: “🗑 Apagar” em cada venda; a já apagada não aparece');
  check(/Mostrar excluídas \(1\)/.test(await page.locator('label:has([data-testid=show-deleted])').innerText()), 'admin: filtro “Mostrar excluídas (1)”');
  const head0 = await txt(page.locator('.big-tag'));
  check(head0.includes('4 vendas'), `total do topo conta só as finalizadas: ${head0}`);
  await shot(page, 'desk-01-vendas-botao-apagar');
  // confirmação: venda em dinheiro do caixa aberto
  await rowOf(page, S.a.number).getByTestId('sale-delete').click(); await page.waitForSelector('[data-testid=del-confirm]');
  const hd = await txt(page.getByTestId('del-head'));
  check(hd.includes(`nº ${S.a.number}`) && hd.includes(brl(S.a.total_cents)) && hd.includes(S.a.created_at.slice(11, 16)) && hd.includes(`${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`), `confirmação mostra número, data e total (${hd.replace(/\n/g, ' ')})`);
  const ef = await txt(page.getByTestId('del-effects'));
  check(/estoque volta \(2 itens\)/.test(ef) && /ainda aberto: sai Dinheiro/.test(ef), `efeitos explicados: ${ef.replace(/\n/g, ' | ')}`);
  check(/Apagar ≠ Cancelar/.test(await page.locator('.del-diff').innerText()), 'explica a diferença Apagar × Cancelar');
  check(await page.getByTestId('del-confirm').isDisabled(), 'botão travado sem motivo e sem o número');
  await page.getByTestId('del-reason').fill('lançada em dobro'); await page.getByTestId('del-number').fill('12');
  check(await page.getByTestId('del-confirm').isDisabled() && /Número diferente/.test(await page.locator('.modal').innerText()), 'número errado: continua travado (“Número diferente”)');
  await page.getByTestId('del-number').fill(String(S.a.number));
  await shot(page, 'desk-02-confirmacao-apagar');
  await page.getByTestId('del-confirm').click(); await page.waitForSelector('[data-testid=del-confirm]', { state: 'detached' });
  const dc = st.calls.find((c) => c[0] === 'sale_delete')?.[1];
  check(dc && dc.p_id === S.a.id && dc.p_reason === 'lançada em dobro' && dc.p_confirm_number === S.a.number, 'sale_delete: id, motivo e número de confirmação enviados');
  await page.waitForFunction((n) => ![...document.querySelectorAll('table tbody tr')].some((r) => r.querySelector('td b')?.textContent === String(n)), S.a.number);
  check((await txt(page.locator('.big-tag'))).includes('3 vendas'), 'apagada some da lista e do total (3 vendas)');
  // fiado / encomenda / caixa fechado: textos
  await rowOf(page, S.b.number).getByTestId('sale-delete').click(); await page.waitForSelector('[data-testid=del-effects]');
  check(/O fiado de Maria Souza diminui/.test(await page.getByTestId('del-effects').innerText()), 'venda no fiado: avisa que o fiado da cliente diminui');
  await page.keyboard.press('Escape'); await sleep(300);
  await rowOf(page, S.c.number).getByTestId('sale-delete').click(); await page.waitForSelector('[data-testid=del-effects]');
  check(/encomenda de Joana Lima volta para “Pronta”/.test(await page.getByTestId('del-effects').innerText()), 'venda de encomenda: a encomenda volta para “Pronta” e “a pagar”');
  await page.keyboard.press('Escape'); await sleep(300);
  await rowOf(page, S.d.number).getByTestId('sale-delete').click(); await page.waitForSelector('[data-testid=del-effects]');
  check(/já fechado: a conferência daquele dia não muda/.test(await page.getByTestId('del-effects').innerText()), 'caixa já fechado (ontem): explica que a conferência não muda');
  check(await rowOf(page, S.d.number).getByRole('button', { name: 'Cancelar' }).count() === 0, 'venda de ontem: não tem “Cancelar” (só do dia), mas tem “Apagar”');
  await page.keyboard.press('Escape'); await sleep(300);
  // Mostrar excluídas
  await page.getByTestId('show-deleted').check(); await sleep(300);
  const delRows = page.locator('table tbody tr[data-status=EXCLUIDA]');
  check(await delRows.count() === 2 && /Excluída/.test(await delRows.first().innerText()) && (await txt(page.locator('.big-tag'))).includes('3 vendas'), 'Mostrar excluídas: as 2 apagadas aparecem riscadas com “Excluída”, fora do total');
  await shot(page, 'desk-03-mostrar-excluidas');
  await rowOf(page, S.a.number).getByRole('button', { name: /Comprovante/ }).click(); await page.waitForSelector('[data-testid=sale-deleted-info]');
  check(/Venda apagada .* por Teste QA\. Motivo: lançada em dobro/.test(await page.getByTestId('sale-deleted-info').innerText()) && await page.getByTestId('comp-pdf').count() === 0 && await page.getByTestId('receipt-delete').count() === 0,
    'detalhe da apagada: quem, quando, motivo; sem comprovante e sem apagar de novo');
  await page.keyboard.press('Escape'); await sleep(300);
  // venda importada do sistema antigo (qualquer dia) pelo detalhe
  st.onlyMine = false; await page.getByTestId('show-deleted').uncheck();
  const [d15] = await sql(`select count(*)::int n from sales where status = 'FINALIZADA' and _local_date(created_at) = '2026-09-15'`);
  await openRange(page, '2026-09-15', '2026-09-15');
  await page.waitForFunction((n) => (document.querySelector('.big-tag')?.textContent ?? '').startsWith(`${n} vendas`), d15.n, { timeout: 15000 }).catch(async (e) => { console.log('DEBUG big-tag:', JSON.stringify(await page.locator('.big-tag').allInnerTexts()), 'rows', await page.locator('table tbody tr').count(), 'first', await page.locator('table tbody tr').first().innerText().catch(() => '')); throw e; });
  const nImp = await page.locator('table tbody tr').count(); const head1 = await txt(page.locator('.big-tag'));
  const first = page.locator('table tbody tr').first(); const impNum = Number(await first.locator('td b').first().innerText());
  await first.getByRole('button', { name: /Comprovante/ }).click(); await page.waitForSelector('[data-testid=receipt-delete]');
  await shot(page, 'desk-04-detalhe-botao-apagar');
  await page.getByTestId('receipt-delete').click(); await page.waitForSelector('[data-testid=del-effects]');
  check(/Venda importada do sistema antigo: só sai dos totais/.test(await page.getByTestId('del-effects').innerText()), `venda importada nº ${impNum} (15/09): pode apagar; só sai dos totais`);
  await page.getByTestId('del-reason').fill('teste QA'); await page.getByTestId('del-number').fill(String(impNum)); await page.getByTestId('del-confirm').click();
  await page.waitForSelector('[data-testid=sale-deleted-info]');
  await shot(page, 'desk-05-detalhe-venda-apagada');
  await page.keyboard.press('Escape'); await sleep(800);
  check(await page.locator('table tbody tr').count() === nImp - 1 && (await txt(page.locator('.big-tag'))) !== head1, `lista do dia 15/09 atualizada (${head1} → ${await txt(page.locator('.big-tag'))})`);
  await ctx.close(); await browser.close();
}

// ---------- 3) gerente e operador: não veem nada de apagar ----------
for (const role of ['gerente', 'operador']) {
  USER = { id: role === 'gerente' ? 992 : 991, name: role === 'gerente' ? 'Gerente QA' : 'Operador QA', role };
  const browser = await launch(); const st = mockState(); const S = seedSales(st);
  const { ctx, page } = await newCtx(browser, st);
  await openRange(page, yesterday, today); await page.waitForSelector(`table tbody tr >> text=${S.b.number}`);
  check(await page.getByTestId('sale-delete').count() === 0 && await page.getByTestId('show-deleted').count() === 0 && await rowOf(page, S.e.number).count() === 0,
    `${role}: sem “Apagar”, sem “Mostrar excluídas” e não vê a venda apagada`);
  check(await rowOf(page, S.b.number).getByRole('button', { name: 'Cancelar' }).count() === 1, `${role}: “Cancelar” do dia continua como antes`);
  await rowOf(page, S.b.number).getByRole('button', { name: /Comprovante/ }).click(); await page.waitForSelector('[data-testid=comp-pdf]');
  check(await page.getByTestId('receipt-delete').count() === 0, `${role}: detalhe da venda sem “Apagar venda”`);
  if (role === 'gerente') await shot(page, 'desk-06-gerente-sem-apagar');
  await ctx.close(); await browser.close();
}

// ---------- 4) celular (admin) ----------
{
  USER = { id: 990, name: 'Teste QA', role: 'admin' };
  const browser = await launch(); const st = mockState(); const S = seedSales(st);
  const { ctx, page } = await newCtx(browser, st, { w: 412, h: 915, mobile: true });
  await openRange(page, yesterday, today); await page.waitForSelector(`table tbody tr >> text=${S.a.number}`);
  await shot(page, 'mob-01-vendas-apagar');
  await rowOf(page, S.b.number).getByTestId('sale-delete').scrollIntoViewIfNeeded();
  await rowOf(page, S.b.number).getByTestId('sale-delete').click(); await page.waitForSelector('[data-testid=del-confirm]');
  await page.getByTestId('del-reason').fill('fiado lançado errado'); await page.getByTestId('del-number').fill(String(S.b.number));
  const bb = await page.getByTestId('del-confirm').boundingBox();
  check(bb && bb.x >= 0 && bb.x + bb.width <= 413, 'celular: botão de confirmar cabe na tela');
  await shot(page, 'mob-02-confirmacao-apagar');
  await page.getByTestId('del-confirm').click(); await page.waitForSelector('[data-testid=del-confirm]', { state: 'detached' });
  await page.getByTestId('show-deleted').check();
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr[data-status=EXCLUIDA]').length === 2, null, { timeout: 8000 }).catch(() => {});
  check(await page.locator('table tbody tr[data-status=EXCLUIDA]').count() === 2, 'celular: Mostrar excluídas');
  await page.getByTestId('show-deleted').scrollIntoViewIfNeeded();
  await shot(page, 'mob-03-mostrar-excluidas');
  await ctx.close(); await browser.close();
}

// ---------- 5) teclado de quantidade: modo travado + sem travar ao trocar ----------
{
  USER = { id: 990, name: 'Teste QA', role: 'admin' };
  const browser = await launch(); const st = mockState();
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  const openPad = async (name) => { await tileOf(page, name).click(); await page.waitForSelector('.pending-bar'); await page.getByTestId('pending-type').click(); await page.waitForSelector('[data-testid=qtypad]'); };
  const mode = () => page.getByTestId('qtypad').getAttribute('data-mode');
  await openPad('Tomate LV');
  check(await mode() === 'peso', 'padrão: ⚖ Peso');
  await page.getByTestId('qpad-valor').click();
  check(await mode() === 'valor' && await page.evaluate(() => localStorage.getItem('folha.qtyMode.990')) === 'valor', 'escolheu R$ Valor: salvo no aparelho para este operador (folha.qtyMode.990)');
  await page.keyboard.type('500'); await sleep(150);
  const kgV = Math.round(500 * 1000 / TP);
  check((await page.locator('.qpad-in').inputValue()).replace(/\u00a0/g, ' ') === 'R$ 5,00' && (await txt(page.getByTestId('qpad-hint'))) === `R$ 5,00 = ${(kgV / 1000).toFixed(3).replace('.', ',')} kg`, 'R$ 5,00 → peso calculado');
  await page.locator('.qpad-quick button', { hasText: 'R$ 2' }).click(); await sleep(100);
  check(await mode() === 'valor' && (await page.locator('.qpad-in').inputValue()).replace(/\u00a0/g, ' ') === 'R$ 7,00', 'botão rápido +R$ 2 soma em reais e NÃO volta para peso (antes os botões +100 g tiravam do modo R$)');
  await shot(page, 'desk-07-modo-valor-travado');
  await page.keyboard.press('Enter'); await page.waitForSelector('[data-testid=qtypad]', { state: 'detached' });
  await openPad('Banana prata');
  check(await mode() === 'valor', 'próximo produto por kg já abre em R$ Valor (travado)');
  await page.reload(); await page.waitForSelector('.tile:not(.empty)');
  await openPad('Tomate LV');
  check(await mode() === 'valor', 'depois de recarregar a página continua em R$ Valor');
  // digitar no campo com o teclado do celular (cursor no fim, sem selecionar): não trava
  await page.locator('.qpad-in').click(); await page.keyboard.press('End');
  for (const k of ['1', '2', '5', '0']) await page.locator('.qpad-in').press(k);
  check((await page.locator('.qpad-in').inputValue()).replace(/\u00a0/g, ' ') === 'R$ 12,50', 'campo R$ no teclado do aparelho: dígitos entram como maquininha (1250 → R$ 12,50)');
  // trocar para peso: converte e continua digitável
  await page.getByTestId('qpad-peso').click();
  const q1 = Math.round(1250 * 1000 / TP);
  check(await mode() === 'peso' && (await page.locator('.qpad-in').inputValue()) === (q1 / 1000).toFixed(3).replace('.', ','), `trocar para Peso converte (${(q1 / 1000).toFixed(3)} kg), sem perder`);
  await page.locator('.qpad-in').click(); await page.keyboard.press('End'); await page.locator('.qpad-in').press('3'); await page.locator('.qpad-in').press('5'); await page.locator('.qpad-in').press('0');
  check((await txt(page.getByTestId('qpad-hint'))) === '350 g = 0,350 kg', 'campo de peso com cursor no fim: digitar 350 vira 0,350 kg (antes podia ficar parado no “0,000”)');
  await page.getByTestId('qpad-valor').click(); await page.getByTestId('qpad-peso').click(); await page.getByTestId('qpad-valor').click(); await page.getByTestId('qpad-peso').click();
  check(await mode() === 'peso' && (await page.getByTestId('qpad-preview').count()) === 1, 'trocar Peso ↔ R$ várias vezes: não trava, mantém a quantidade');
  await shot(page, 'desk-08-modo-peso-travado');
  await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape'); await sleep(200);
  check(await page.evaluate(() => localStorage.getItem('folha.qtyMode.990')) === 'peso', 'voltou para Peso: fica salvo Peso');
  // produto por unidade e peso manual (F2, sem produto) não usam R$
  await page.evaluate(() => localStorage.setItem('folha.qtyMode.990', 'valor'));
  await blur(page); await page.keyboard.press('F2'); await page.waitForSelector('[data-testid=qtypad]');
  check(await mode() === 'peso' && await page.getByTestId('qpad-valor').count() === 0, 'F2 peso manual (sem produto): sempre em peso (antes ficaria preso em R$ 0)');
  await page.keyboard.press('Escape'); await sleep(300);
  await tileOf(page, 'Alface').click(); await sleep(300); await page.locator('.cart-line', { hasText: 'Alface' }).click(); await page.waitForSelector('[data-testid=qtypad]');
  check(await mode() === 'un' && await page.getByTestId('qpad-valor').count() === 0, 'produto por unidade: continua em unidades (− / + e 1·2·3·6·12)');
  await page.keyboard.press('Escape'); await sleep(300);
  // editar linha em kg já no modo R$: mantém a quantidade se não mexer
  await page.evaluate(() => localStorage.setItem('folha.qtyMode.990', 'peso'));
  await openPad('Tomate LV'); await page.keyboard.type('1,5'); await page.keyboard.press('Enter'); await sleep(300);
  await page.evaluate(() => localStorage.setItem('folha.qtyMode.990', 'valor'));
  await page.locator('.cart-line', { hasText: 'Tomate LV' }).click(); await page.waitForSelector('[data-testid=qtypad]');
  check(await mode() === 'valor' && /^1,500 kg/.test(await txt(page.getByTestId('qpad-preview'))), 'editar linha em R$ Valor: mostra o valor da linha e mantém 1,500 kg se não mexer');
  await page.getByTestId('line-save').click(); await sleep(300);
  check(/1,500 kg/.test(await cartText(page)), 'salvar sem mexer: continua 1,500 kg (sem arredondar)');
  await ctx.close(); await browser.close();
}
// celular: modo bem visível
{
  const browser = await launch(); const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { w: 412, h: 915, mobile: true });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await page.evaluate(() => localStorage.setItem('folha.qtyMode.990', 'valor'));
  await tileOf(page, 'Banana prata').click(); await page.waitForSelector('[data-testid=qtypad]');
  check(await page.getByTestId('qtypad').getAttribute('data-mode') === 'valor' && (await page.getByTestId('qpad-badge').innerText()) === 'R$ VALOR', 'celular: abre travado em R$ Valor, com selo “R$ VALOR” no visor');
  for (const k of ['1', '0', '0', '0']) await page.locator('.qpad-keys button', { hasText: new RegExp(`^${k}$`) }).click();
  await shot(page, 'mob-04-modo-valor-travado');
  await page.getByTestId('qpad-peso').click(); await sleep(200);
  await shot(page, 'mob-05-modo-peso');
  await ctx.close(); await browser.close();
}

// ---------- banco: só admin, de verdade ----------
{
  const [f] = await sql(`select position('u.role <> ''admin''' in prosrc) > 0 admin_only, has_function_privilege('anon', 'sale_delete(text,int,text,int)', 'EXECUTE') anon_exec,
    has_function_privilege('authenticated', 'sale_delete(text,int,text,int)', 'EXECUTE') auth_exec, has_table_privilege('authenticated', 'sales', 'UPDATE') upd, has_table_privilege('authenticated', 'sales', 'DELETE') del
    from pg_proc where proname = 'sale_delete'`);
  check(f.admin_only && !f.anon_exec && f.auth_exec && !f.upd && !f.del, `sale_delete no banco: confere admin; anon não executa; ninguém altera/apaga a tabela sales direto (${JSON.stringify(f)})`);
}
// ---------- o banco de verdade não mudou ----------
const [after] = await sql(SNAP);
const [mine] = await sql(`select coalesce(json_agg(json_build_object('id', id, 'action', action, 'user_id', user_id)), '[]') j from audit_log where created_at > now() - interval '20 minutes' and user_id is not null`);
if (mine.j.length) ok(`ações reais de usuários no app durante o QA (não são do teste): ${JSON.stringify(mine.j)}`);
const strip = (o) => ({ ...o, sales: undefined, last_number: undefined, sale_items: undefined, stock_movements: undefined, cash_moves: undefined, stock_sum: undefined, total_finalizadas: undefined, ledger: undefined });
check(JSON.stringify(strip(after)) === JSON.stringify(strip(before)) && after.excluidas === before.excluidas && after.sales >= before.sales, `banco real intacto (nenhuma venda apagada; fora vendas reais do Rafael): ${JSON.stringify(after)}`);
fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA v3.4 em ${BASE}\n${new Date().toString()}\n(gravações respondidas por banco de mentira em memória; banco real só lido)\n\n${results.join('\n')}\n\n${fails ? fails + ' FALHA(S)' : 'TUDO OK'}\n`);
console.log(fails ? `\n${fails} falha(s)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
