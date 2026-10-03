// QA da v3.2 (promoções + calendário do livro caixa) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-v32.mjs [URL]   (padrão: URL publicada)
//
// NÃO cria conta nem grava nada no banco de verdade: o banco já tem a conta do dono. O site é o publicado (GitHub Pages),
// mas as chamadas ao Supabase são respondidas por um "banco de mentira" em memória dentro do teste, montado com uma
// LEITURA (select) dos produtos/categorias/configuração reais. Câmera falsa do Chrome com vídeo de código de barras.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = (process.argv[2] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/v3.2');
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
const SNAP = `select (select count(*) from promotions)::int promotions, (select count(*) from auth.users)::int auth, (select count(*) from users)::int users, (select count(*) from products)::int products,
  (select count(*) from products where deleted_at is null)::int visible, (select count(*) from sales)::int sales, (select count(*) from sale_items)::int sale_items,
  (select count(*) from audit_log where user_id is null)::int audit_sem_usuario, (select count(*) from cash_sessions)::int cash, (select last_sale_number from store_settings)::int last_number`;
const [fx] = await sql(`select (select json_agg(v order by v.name) from v_products v) products, (select json_agg(c order by c.id) from categories c) cats, _settings_json() settings,
  (select auth_uid from users where username = 'rafael') owner`);
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
function mockState() {
  const products = JSON.parse(JSON.stringify(fx.products));
  const promos = []; let pid = 900;
  const add = (name, pct, startMs, endMs, endedMs = null) => {
    const p = products.find((x) => x.name === name); if (!p) throw new Error('sem produto ' + name);
    const promo = Math.max(1, Math.round((p.price_cents * (100 - pct)) / 1000) * 10 - 1);
    const row = { id: ++pid, product_id: p.id, promo_price_cents: promo, starts_at: ts(startMs), ends_at: ts(endMs), ended_at: endedMs ? ts(endedMs) : null, note: null, created_at: ts(startMs),
      product_name: p.name, product_icon: p.icon, product_unit: p.unit, product_code: p.code, regular_price_cents: p.price_cents, product_deleted: false, created_by_name: 'Rafael', items_sold: 0, total_sold_cents: 0 };
    promos.push(row); return row;
  };
  const st = { products, promos, add, cats: fx.cats, settings: { ...fx.settings }, saved: [], deleted: [], calls: [], sales: [],
    usage: {} };
  return st;
}
function syncProducts(st) { // v_products: promoção vigente ou a próxima, como no banco
  const now = Date.now();
  for (const p of st.products) {
    const c = st.promos.filter((x) => x.product_id === p.id && untilMs(x) > now).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
    Object.assign(p, { promo_id: c?.id ?? null, promo_price_cents: c?.promo_price_cents ?? null, promo_starts_at: c?.starts_at ?? null, promo_ends_at: c ? ts(untilMs(c)) : null });
  }
}
const untilMs = (x) => Math.min(Date.parse(x.ends_at), x.ended_at ? Date.parse(x.ended_at) : Infinity);
const promoStatus = (x) => { const n = Date.now(); const u = untilMs(x); return u <= n ? (x.ended_at && Date.parse(x.ended_at) < Date.parse(x.ends_at) ? 'ENCERRADA' : 'EXPIRADA') : Date.parse(x.starts_at) > n ? 'AGENDADA' : 'ATIVA'; };
// como o PostgREST manda timestamptz: ISO com fuso
const ts = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
function unused() {
  return { products: [], cats: fx.cats, settings: { ...fx.settings }, saved: [], deleted: [], calls: [],
    usage: { 'Banana prata': { sales: 37, movements: 2, lots: 0, losses: 1 }, 'Tomate LV': { sales: 52, movements: 0, lots: 1, losses: 0 } } };
}
const session = { id: 1, terminal: 'QA-V3', status: 'ABERTO', opened_by: USER.id, opened_by_name: USER.name, opened_at: '2026-10-02 19:40:00', opening_float_cents: 10000, closed_at: null };
const status = (st) => ({ store: st.settings, terminal: 'QA-V3', user: USER, held_count: 0, alerts: { expiring: [], low_stock: [] },
  session: { session, by_method: [{ method: 'dinheiro', expected_cents: 10000 }], movements: [], expected_total_cents: 10000, sangria_cents: 0, suprimento_cents: 0, estorno_cents: 0, opening_float_cents: 10000, sales_count: 0, sales_total_cents: 0, canceled_count: 0, canceled_total_cents: 0, ticket_medio_cents: 0 } });
function filterRows(rows, sp) {
  let r = rows;
  const val = (v) => v.replace(/^"|"$/g, '');
  const test = (row, col, op, v) => {
    const x = row[col];
    if (op === 'eq') return String(x) === val(v);
    if (op === 'in') return v.replace(/^\(|\)$/g, '').split(',').map(val).includes(String(x));
    if (op === 'is') return v === 'null' ? x == null : String(x) === v;
    if (op === 'ilike') return String(x ?? '').toLowerCase().includes(val(v).replace(/\*/g, '').toLowerCase());
    return true;
  };
  for (const [k, v] of sp) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'or') {
      const parts = v.replace(/^\(|\)$/g, '').split(',').map((p) => p.split('.'));
      r = r.filter((row) => parts.some(([col, op, ...rest]) => test(row, col, op, rest.join('.'))));
      continue;
    }
    const [op, ...rest] = v.split('.');
    if (op === 'not') { const [op2, ...r2] = rest; r = r.filter((row) => !test(row, k, op2, r2.join('.'))); }
    else r = r.filter((row) => test(row, k, op, rest.join('.')));
  }
  const lim = Number(sp.get('limit')); if (lim) r = r.slice(0, lim);
  return r;
}
async function installMock(ctx, st) {
  const fakeJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ sub: '00000000-0000-4000-8000-000000000990', exp: Math.floor(Date.now() / 1000) + 86400, role: 'authenticated', email: 'qa-v3@folhacaixa.app' })).toString('base64url'), 'x'].join('.');
  const user = { id: '00000000-0000-4000-8000-000000000990', aud: 'authenticated', role: 'authenticated', email: 'qa-v3@folhacaixa.app', app_metadata: { provider: 'email' }, user_metadata: { username: 'qa-v3' }, created_at: '2026-10-02T22:00:00Z' };
  const sess = { access_token: fakeJwt, token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'qa', user };
  await ctx.addInitScript(([s]) => {
    if (!localStorage.getItem('folha.qa')) {
      localStorage.setItem('folha.qa', '1');
      localStorage.setItem('folha.sb.auth', s); localStorage.setItem('folha.token', 'qa-token'); localStorage.setItem('folha.terminal', 'QA-V3');
    }
  }, [JSON.stringify(sess)]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
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
      if (fn === 'op_me') return json(USER);
      if (fn === 'app_status') return json(status(st));
      if (fn === 'product_save') {
        const d = body.p_data; const cat = st.cats.find((c) => c.id === Number(d.category_id));
        if (st.products.some((x) => x.id !== body.p_id && (x.code === d.code || (d.ean && x.ean === d.ean)))) return json({ message: 'Código/EAN já usado.', hint: 'CONFLITO', code: 'P0001' }, 400);
        let row;
        if (body.p_id) { row = st.products.find((x) => x.id === body.p_id); Object.assign(row, d, { ean: d.ean || null }); }
        else { row = { ...d, id: Math.max(...st.products.map((x) => x.id)) + 1, ean: d.ean || null, stock_qty: d.initial_stock ?? 0, category_name: cat?.name, category_color: cat?.color }; st.products.push(row); }
        st.saved.push(row); return json(row);
      }
      if (fn === 'product_usage') {
        const p = st.products.find((x) => x.id === body.p_id); const u = { sales: 0, movements: 0, lots: 0, losses: 0, ...(st.usage[p?.name] ?? {}) };
        return json({ ...u, has_history: u.sales + u.movements + u.lots + u.losses > 0 });
      }
      if (fn === 'product_delete') {
        st.calls.push(['delete', body.p_id]);
        if (USER.role === 'operador') return json({ message: 'Seu usuário não tem permissão para isso.', hint: 'PROIBIDO', code: 'P0001' }, 400);
        const i = st.products.findIndex((x) => x.id === body.p_id); if (i < 0) return json({ message: 'Produto não encontrado (ou já apagado).', hint: 'NAO_ENCONTRADO', code: 'P0001' }, 400);
        const p = st.products[i]; const u = st.usage[p.name]; const soft = !!u;
        st.products.splice(i, 1);
        if (soft) st.deleted.push({ ...p, active: false, shortcut_pos: null, deleted_at: new Date().toISOString(), code: `${p.code}~${p.id}`, original_code: p.code, ean: p.ean ? `${p.ean}~${p.id}` : null, original_ean: p.ean });
        return json({ id: p.id, name: p.name, mode: soft ? 'soft' : 'hard', usage: u ?? {} });
      }
      if (fn === 'product_restore') {
        st.calls.push(['restore', body.p_id]);
        const i = st.deleted.findIndex((x) => x.id === body.p_id); const p = st.deleted.splice(i, 1)[0];
        const back = { ...p, code: p.original_code, ean: p.original_ean, active: true, deleted_at: null }; delete back.original_code; delete back.original_ean;
        st.products.push(back); st.products.sort((a, b) => a.name.localeCompare(b.name)); return json({ ...back, warning: null });
      }
      // leituras REAIS (só select) para mostrar as vendas importadas do Rafael
      if (fn === 'report') {
        const r = await realRpc(`report(${dateLit(body.p_from)}, ${dateLit(body.p_to)})`);
        // a venda de teste (em memória) com itens em promoção entra no resumo, como o banco faria
        const its = st.sales.flatMap((s) => s.items.filter((i) => i.promotion_id));
        if (its.length && body.p_to >= '2026-10-02') Object.assign(r.summary, { promo_items_count: its.length, promo_sales_count: st.sales.length,
          promo_total_cents: its.reduce((a, i) => a + i.total_cents, 0), promo_savings_cents: its.reduce((a, i) => a + Math.round(((i.regular_price_cents - i.unit_price_cents) * i.qty) / 1000), 0) });
        return json(r);
      }
      if (fn === 'sale_get') { const m = st.sales.find((x) => x.id === Number(body.p_id)); if (m) return json(m); return json(await realRpc(`sale_get(${Number(body.p_id)})`)); }
      if (fn === 'top_sellers' || fn === 'expiring_lots') return json([]);
      if (fn === 'cash_book_days') return json(await realRpc(`cash_book_days(${dateLit(body.p_from)}, ${dateLit(body.p_to)})`));
      if (fn === 'cash_book_detail') return json(await realRpc(`cash_book_detail(${dateLit(body.p_from)}, ${dateLit(body.p_to)})`));
      if (fn === 'promo_save') {
        st.calls.push(['promo_save', body.p_data]);
        if (USER.role === 'operador') return json({ message: 'Seu usuário não tem permissão para isso.', hint: 'PROIBIDO', code: 'P0001' }, 400);
        const d = body.p_data; const a = Date.parse(d.starts_at); const b = Date.parse(d.ends_at);
        const made = d.items.map((it) => { const p = st.products.find((x) => x.id === it.product_id); const r = st.add(p.name, 0, a, b); r.promo_price_cents = it.promo_price_cents; return { ...r, status: promoStatus(r), ends_until: r.ends_at }; });
        syncProducts(st); return json(made);
      }
      if (fn === 'promo_end') {
        st.calls.push(['promo_end', body.p_id]);
        const r = st.promos.find((x) => x.id === body.p_id); r.ended_at = ts(Math.max(Date.now(), Date.parse(r.starts_at)) - 1000); if (Date.parse(r.starts_at) > Date.now()) r.ended_at = r.starts_at;
        syncProducts(st); return json({ ...r, status: promoStatus(r), ends_until: ts(untilMs(r)) });
      }
      if (fn === 'sale_create') {
        st.calls.push(['sale_create', body]);
        const d = body.p_data ?? body; const items = (d.items ?? []).map((it) => {
          const p = st.products.find((x) => x.id === it.product_id); const promo = it.promotion_id ? st.promos.find((x) => x.id === it.promotion_id) : null;
          const unit = promo ? promo.promo_price_cents : p.price_cents; const gross = Math.round((unit * it.qty) / 1000); // qty em milésimos (2000 = 2 un; 1500 = 1,5 kg)
          return { product_id: p.id, name: p.name, unit: p.unit, qty: it.qty, unit_price_cents: unit, gross_cents: gross, discount_cents: 0, total_cents: gross, promotion_id: promo?.id ?? null, regular_price_cents: p.price_cents };
        });
        const total = items.reduce((a, i) => a + i.total_cents, 0);
        const sale = { id: 99001, number: 3245, client_uuid: d.client_uuid, created_at: '2026-10-02 20:55:00', terminal: 'QA-V3', user_name: USER.name, status: 'FINALIZADA', imported: false,
          items, payments: [{ method: 'dinheiro', amount_cents: total, net_cents: total, change_cents: 0 }], subtotal_cents: total, discount_cents: 0, total_cents: total, change_cents: 0, fiscal: { status: 'SIMULADA' } };
        st.sales.push(sale); return json(sale);
      }
      if (fn === 'settings_update') { Object.assign(st.settings, body.p_data); return json(st.settings); }
      if (fn === 'pin_users') return json([{ id: USER.id, name: USER.name, role: USER.role }]);
      return json([]);
    }
    if (p === '/rest/v1/v_products') { const rows = filterRows(st.products, url.searchParams); return json(single ? rows[0] : rows); }
    if (p === '/rest/v1/v_products_deleted') return json(st.deleted);
    if (p === '/rest/v1/v_promotions') return json(st.promos.map((x) => ({ ...x, status: promoStatus(x), ends_until: ts(untilMs(x)),
      regular_price_cents: st.products.find((p) => p.id === x.product_id)?.price_cents ?? x.regular_price_cents })).sort((a, b) => b.starts_at.localeCompare(a.starts_at)));
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
async function launch(videoFile, { fakeUi = true } = {}) {
  const args = ['--no-sandbox', '--lang=pt-BR', '--autoplay-policy=no-user-gesture-required'];
  if (videoFile) args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoFile}`);
  if (fakeUi) args.push('--use-fake-ui-for-media-stream');
  return chromium.launch({ executablePath: exe, args });
}
async function newCtx(browser, st, { w = 1366, h = 768, mobile = false, camera = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    isMobile: mobile, hasTouch: mobile, userAgent: mobile ? MOBILE_UA : undefined, serviceWorkers: 'block', permissions: camera ? ['camera'] : [] });
  await installMock(ctx, st);
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => bad('erro na página: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) console.error('console', m.text()); });
  return { ctx, page };
}
const shot = async (page, name) => { await sleep(500); await page.screenshot({ path: path.join(out, name + '.png') }); console.log('📸', name); };
const cartText = (page) => page.locator('.cart-list').innerText().catch(() => '');
const wedge = async (page, code) => { await page.keyboard.type(code, { delay: 6 }); await page.keyboard.press('Enter'); };
const blur = (page) => page.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus(); });


// ---------- 1) versão publicada ----------
{
  const sw = await (await fetch(BASE + 'sw.js', { cache: 'no-store' })).text();
  const ver = sw.match(/const VERSION = '([^']+)'/)?.[1];
  check(ver === '3.2.0', `sw.js publicado: versão ${ver} (aparece "Atualizar agora" no app instalado)`);
}
const H = 3600e3; const NOW = Date.now();
const today7 = new Date(); today7.setHours(7, 0, 0, 0);
const endToday = new Date(); endToday.setHours(23, 59, 0, 0);
function seedPromos(st) {
  st.add('Tomate LV', 25, today7.getTime(), endToday.getTime() + 2 * 24 * H);
  st.add('Abacaxi', 20, today7.getTime(), endToday.getTime());
  st.add('Banana prata', 15, today7.getTime(), endToday.getTime() + 24 * H);
  st.add('Morango', 20, today7.getTime() + 24 * H, endToday.getTime() + 24 * H); // agendada para amanhã
  st.add('Alho', 10, today7.getTime() - 3 * 24 * H, endToday.getTime() - 2 * 24 * H); // já acabou
  syncProducts(st);
}
const tileOf = (page, name) => page.locator('.tile:not(.empty)').filter({ hasText: name }).first();

// ---------- 2) computador 1366x768 (admin) ----------
{
  const browser = await launch(null);
  const st = mockState(); seedPromos(st);
  const { ctx, page } = await newCtx(browser, st, { camera: false });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  const tomato = (await tileOf(page, "Tomate LV").innerText()).replace(/\u00a0/g, " ");
  const tp = st.products.find((p) => p.name === 'Tomate LV');
  check(/PROMO/.test(tomato) && tomato.includes(brl(tp.promo_price_cents).slice(3)) && tomato.includes(brl(tp.price_cents).slice(3)), `atalho Tomate LV: selo PROMO, ${brl(tp.price_cents)} riscado e ${brl(tp.promo_price_cents)}`);
  check(!/PROMO/.test(await tileOf(page, 'Morango').innerText()), 'Morango (promoção só amanhã) ainda com preço normal');
  check(!/PROMO/.test(await tileOf(page, 'Alho').innerText()), 'Alho (promoção que já acabou) com preço normal');
  check(await page.locator('.tile-promo').count() === 3, `3 atalhos com PROMO (Tomate LV, Abacaxi, Banana prata)`);
  await shot(page, 'desk-01-venda-atalhos-promo');
  // sacola + pagamento: o app manda promotion_id
  await tileOf(page, 'Abacaxi').click(); await tileOf(page, 'Abacaxi').click();
  await page.waitForSelector('.cart-line');
  check(/PROMO/.test(await cartText(page)), 'sacola mostra PROMO e o preço antigo riscado');
  await blur(page); await page.keyboard.type('1,500', { delay: 20 }); await page.keyboard.press('Enter'); await tileOf(page, 'Tomate LV').click();
  await sleep(500);
  await shot(page, 'desk-02-sacola-promo');
  await page.keyboard.press('F10'); await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'Dinheiro' }).click();
  await page.locator('.bills .btn').last().click().catch(() => {});
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.waitForSelector('.modal >> text=Venda nº 3245');
  const sc = st.calls.find((c) => c[0] === 'sale_create')?.[1]?.p_data;
  const ab = st.products.find((p) => p.name === 'Abacaxi');
  check(sc && sc.items.every((i) => i.promotion_id), `venda enviada com promotion_id em cada item (${JSON.stringify(sc?.items)})`);
  const rec = await page.locator('.modal').innerText();
  check(/PROMOÇÃO \(de/.test(rec), 'cupom mostra “PROMOÇÃO (de R$ …)” nos itens em promoção');
  await shot(page, 'desk-03-cupom-promocao');
  await page.keyboard.press('Escape'); await sleep(400);

  // Promoções
  await page.goto(BASE + '#/promocoes'); await page.waitForSelector('[data-testid=promos] table, [data-testid=promos] .promo-empty');
  const pl = await page.getByTestId('promos').innerText();
  check(/Ativas \(3\)/.test(pl) && /Agendadas \(1\)/.test(pl) && /Encerradas \(1\)/.test(pl), 'Promoções: 3 ativas, 1 agendada, 1 encerrada');
  await shot(page, 'desk-04-promocoes-ativas');
  await page.getByRole('button', { name: /Agendadas/ }).click(); await sleep(300);
  check(/Morango/.test(await page.getByTestId('promos').innerText()), 'aba Agendadas: Morango');
  await page.getByRole('button', { name: /Encerradas/ }).click(); await sleep(300);
  check(/Alho/.test(await page.getByTestId('promos').innerText()), 'aba Encerradas: Alho');
  await page.getByRole('button', { name: /Ativas/ }).click();
  // nova promoção em lote
  await page.getByTestId('promo-new').click(); await page.waitForSelector('[data-testid=promo-save]');
  for (const n of ['Cebola', 'Batata', 'Cenoura']) {
    await page.getByTestId('promo-search').fill(n); await sleep(200);
    await page.getByLabel(`Promoção ${n}`, { exact: true }).check();
  }
  await page.getByTestId('promo-search').fill('');
  await page.getByRole('button', { name: /Aplicar −\d+% nos escolhidos/ }).click();
  await page.getByRole('button', { name: 'Amanhã 23:59' }).click();
  await sleep(300);
  await shot(page, 'desk-05-nova-promocao-em-lote');
  await page.getByTestId('promo-save').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  const saved = st.calls.find((c) => c[0] === 'promo_save')?.[1];
  check(saved?.items?.length === 3 && saved.items.every((i) => i.promo_price_cents < st.products.find((p) => p.id === i.product_id).price_cents) && Date.parse(saved.ends_at) > Date.now(),
    `promo_save em lote: 3 produtos, preços abaixo do normal, até ${saved && new Date(saved.ends_at).toLocaleString('pt-BR')}`);
  await page.waitForFunction(() => /Ativas \(6\)/.test(document.querySelector('[data-testid=promos]')?.textContent ?? ''));
  ok('lista atualizada: 6 promoções ativas');
  // encerrar antes
  const row = page.locator('[data-testid=promos] tr').filter({ hasText: 'Banana prata' });
  await row.getByRole('button', { name: 'Encerrar agora' }).click();
  await page.getByTestId('promo-end-confirm').click();
  await page.waitForFunction(() => /Ativas \(5\)/.test(document.querySelector('[data-testid=promos]')?.textContent ?? ''));
  check(st.calls.some((c) => c[0] === 'promo_end'), 'Encerrar agora: Banana prata saiu das ativas (promo_end)');
  // WhatsApp
  await page.getByTestId('promo-whats').click(); await page.waitForSelector('[data-testid=promo-text]');
  const wt = await page.getByTestId('promo-text').innerText();
  check(/^🥬 \*Hortifruti Frutos da Roça — Preços\*/.test(wt) && /Tomate LV: ~R\$/.test(wt) && /Cebola/.test(wt) && !/Banana prata/.test(wt) && !/Morango/.test(wt),
    'texto do WhatsApp: “🥬 *Hortifruti Frutos da Roça — Preços*”, só as ativas, preço antigo riscado (~…~) e promocional em negrito');
  await shot(page, 'desk-06-enviar-promocoes-whatsapp');
  await page.getByTestId('promo-copy').click(); await page.waitForSelector('.toast >> text=copiada');
  ok('📋 Copiar texto funciona');
  await page.keyboard.press('Escape'); await sleep(300);
  // a venda reflete: Banana prata volta ao normal, Cebola entra em PROMO
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  check(!/PROMO/.test(await tileOf(page, 'Banana prata').innerText()) && /PROMO/.test(await tileOf(page, 'Cebola').innerText()), 'venda: Banana prata voltou ao preço normal; Cebola em PROMO');
  // Preço do dia e lista
  await page.goto(BASE + '#/produtos/precos'); await page.waitForSelector('.prices .price-in');
  check(/PROMO/.test(await page.locator('.prices').innerText()), 'Preço do dia mostra o selo PROMO e o preço valendo');
  await shot(page, 'desk-07-preco-do-dia-promo');
  // Hoje / Relatórios com a venda em promoção
  await page.goto(BASE + '#/hoje'); await page.waitForSelector('[data-testid=today-promo]');
  ok('Hoje: “🔥 Vendido em promoção” (com a venda de teste)');
  await shot(page, 'desk-08-hoje-vendido-em-promocao');
  await page.goto(BASE + '#/relatorios'); await page.waitForSelector('[data-testid=promo-summary]');
  ok('Relatórios: resumo “Vendido em promoção … o freguês economizou …”');

  // ---- Livro caixa ----
  await page.goto(BASE + '#/caixa'); await page.waitForSelector('[data-testid=cashbook] .cb-day');
  await page.waitForSelector('[data-testid=cb-detail] .stat');
  check(await page.locator('.cb-day.today').count() === 1, 'calendário marca hoje');
  await page.getByTestId('cashbook').scrollIntoViewIfNeeded();
  await shot(page, 'desk-09-livro-caixa-outubro-hoje');
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await page.waitForFunction(() => /setembro/.test(document.querySelector('.cb-month')?.textContent ?? '') && /56\.617,12/.test(document.querySelector('[data-testid=cb-month-total]')?.textContent ?? ''));
  ok('setembro/2026: total do mês R$ 56.617,12 (vendas importadas incluídas)');
  const withSales = await page.locator('.cb-day:not(.out)[class*=lvl]:not(.lvl0)').count();
  check(withSales >= 25, `setembro: ${withSales} dias destacados com venda`);
  const [d15] = await sql(`select count(*)::int n, sum(total_cents)::int t from sales where status='FINALIZADA' and (created_at at time zone 'America/Sao_Paulo')::date = '2026-09-15'`);
  await page.locator('.cb-day[data-day="2026-09-15"]').click();
  await page.waitForFunction((t) => { const d = document.querySelector('[data-testid=cb-detail]'); return /15\/09/.test(d?.querySelector('h4')?.textContent ?? '') && (d?.textContent ?? '').replace(/\u00a0/g, ' ').includes(t); }, brl(d15.t)).catch(() => {});
  const dt = (await page.getByTestId("cb-detail").innerText()).replace(/\u00a0/g, " ");
  check(dt.includes(brl(d15.t)) && dt.includes(`${d15.n} venda`) && /Não informado/.test(dt), `toque em 15/09: ${d15.n} vendas, ${brl(d15.t)} (confere com o banco), forma “Não informado”, importadas`);
  await shot(page, 'desk-10-livro-caixa-setembro-dia-15');
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await page.waitForFunction(() => /agosto/.test(document.querySelector('.cb-month')?.textContent ?? '') && /13\.132,97/.test(document.querySelector('[data-testid=cb-month-total]')?.textContent ?? ''));
  ok('agosto/2026: total do mês R$ 13.132,97');
  // filtros rápidos
  await page.getByRole('button', { name: 'Ontem', exact: true }).click();
  await page.waitForFunction(() => /01\/10/.test(document.querySelector('[data-testid=cb-detail] h4')?.textContent ?? ''));
  check(/outubro/i.test(await page.locator('.cb-month').innerText()), 'Ontem: volta para outubro e mostra 01/10');
  await page.getByRole('button', { name: 'Esta semana', exact: true }).click(); await sleep(800);
  check(/ a /.test(await page.locator('[data-testid=cb-detail] h4').innerText()), `Esta semana: ${await page.locator('[data-testid=cb-detail] h4').innerText()}`);
  await page.getByRole('button', { name: 'Este mês', exact: true }).click(); await sleep(800);
  await page.getByRole('button', { name: 'Período…' }).click();
  await page.getByLabel('De', { exact: true }).fill('2026-08-01'); await page.getByLabel('Até', { exact: true }).fill('2026-09-30');
  await page.getByRole('button', { name: 'Ver período' }).click();
  await page.waitForFunction(() => /69\.750,09/.test(document.querySelector('[data-testid=cb-detail]')?.textContent ?? ''), null, { timeout: 30000 });
  ok('Período 01/08 a 30/09: R$ 69.750,09 (= agosto + setembro importados)');
  await shot(page, 'desk-11-livro-caixa-periodo-ago-set');
  await ctx.close(); await browser.close();
}

// ---------- 3) celular 412x915 ----------
{
  const browser = await launch(null);
  const st = mockState(); seedPromos(st);
  // promoção que acaba daqui a 20 s: o preço tem que voltar sozinho, sem recarregar
  st.add('Cebola', 20, NOW - H, Date.now() + 20000); syncProducts(st);
  const { ctx, page } = await newCtx(browser, st, { w: 412, h: 915, mobile: true, camera: false });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  check(/PROMO/.test(await tileOf(page, 'Cebola').innerText()), 'celular: Cebola em PROMO (acaba em 20 s)');
  await shot(page, 'mob-01-venda-atalhos-promo');
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('.tile')].find((e) => /Cebola/.test(e.textContent)); return t && !/PROMO/.test(t.textContent); }, null, { timeout: 40000 });
  ok('celular: quando a promoção acabou, a Cebola voltou ao preço normal sozinha (sem recarregar)');
  await page.goto(BASE + '#/promocoes'); await page.waitForSelector('[data-testid=promos] table, [data-testid=promos] .promo-empty');
  await shot(page, 'mob-02-promocoes');
  await page.getByTestId('promo-new').click(); await page.waitForSelector('[data-testid=promo-save]');
  await page.getByLabel('Promoção Batata', { exact: true }).check(); await page.getByLabel('Promoção Cenoura', { exact: true }).check();
  await sleep(300); await shot(page, 'mob-03-nova-promocao');
  await page.keyboard.press('Escape'); await sleep(300);
  await page.getByTestId('promo-whats').click(); await page.waitForSelector('[data-testid=promo-text]');
  await shot(page, 'mob-04-enviar-promocoes');
  await page.keyboard.press('Escape'); await sleep(300);
  await page.goto(BASE + '#/caixa'); await page.waitForSelector('[data-testid=cashbook] .cb-day');
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await page.waitForFunction(() => /56\.617,12/.test(document.querySelector('[data-testid=cb-month-total]')?.textContent ?? ''));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const inner = await page.evaluate(() => { const c = document.querySelector('[data-testid=cashbook]'); const g = document.querySelector('.cb-grid'); return Math.max(c.scrollWidth - c.clientWidth, g.scrollWidth - g.clientWidth, g.getBoundingClientRect().right - c.getBoundingClientRect().right); });
  check(overflow <= 1 && inner <= 1, `celular: calendário cabe na tela (sobra lateral página ${overflow}px, dentro do cartão ${Math.round(inner)}px)`);
  await page.locator('.cb-cal').scrollIntoViewIfNeeded();
  await shot(page, 'mob-05-livro-caixa-setembro');
  await page.locator('.cb-day[data-day="2026-09-20"]').tap();
  await page.waitForFunction(() => /20\/09/.test(document.querySelector('[data-testid=cb-detail] h4')?.textContent ?? ''));
  await sleep(600); await page.locator('[data-testid=cb-detail]').scrollIntoViewIfNeeded();
  await shot(page, 'mob-06-livro-caixa-dia-20-09');
  check(!st.calls.some((c) => c[0] === 'promo_save'), 'celular: só abriu as telas (nada salvo)');
  await ctx.close(); await browser.close();
}

// ---------- 4) operador ----------
{
  USER = { id: 991, name: 'Operador QA', role: 'operador' };
  const browser = await launch(null);
  const st = mockState(); seedPromos(st);
  const { ctx, page } = await newCtx(browser, st, { camera: false });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  check(/PROMO/.test(await tileOf(page, 'Tomate LV').innerText()), 'operador: vende com o preço da promoção');
  const nav = await page.locator('header').innerText();
  await page.goto(BASE + '#/promocoes'); await sleep(1500);
  check(!/Promoções/.test(nav) && await page.getByTestId('promos').count() === 0, 'operador: sem menu Promoções; o link #/promocoes abre a venda');
  await page.goto(BASE + '#/caixa'); await sleep(2000);
  check(await page.getByTestId('cashbook').count() === 0, 'operador: livro caixa (calendário) só para gerente/admin');
  await ctx.close(); await browser.close();
}

// ---------- banco: RLS das promoções ----------
{
  const pol = await sql(`select policyname, cmd from pg_policies where tablename = 'promotions'`);
  const [rls] = await sql(`select relrowsecurity r from pg_class where relname = 'promotions'`);
  const [gr] = await sql(`select has_table_privilege('authenticated', 'promotions', 'INSERT') ins, has_table_privilege('authenticated', 'promotions', 'UPDATE') upd, has_table_privilege('anon', 'promotions', 'SELECT') anon_sel`);
  check(rls.r && pol.every((p) => p.cmd === 'SELECT') && !gr.ins && !gr.upd && !gr.anon_sel, `promotions: RLS ligado, só leitura direta (${JSON.stringify(pol)}); gravar só por promo_save/promo_end, que exigem gerente/admin`);
}

// ---------- o banco de verdade não mudou ----------
const [after] = await sql(SNAP);
const [mine] = await sql(`select coalesce(json_agg(json_build_object('id', id, 'action', action, 'user_id', user_id)), '[]') j from audit_log where created_at > now() - interval '15 minutes' and user_id is not null`);
if (mine.j.length) ok(`ações reais de usuários no app durante o QA (não são do teste): ${JSON.stringify(mine.j)}`);
const strip = (o) => ({ ...o, sales: undefined, last_number: undefined });
check(JSON.stringify(strip(after)) === JSON.stringify(strip(before)) && after.sales === before.sales, `banco real intacto durante o QA: ${JSON.stringify(after)}`);

fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA v3.2 em ${BASE}\n${new Date().toString()}\n(gravações respondidas por banco de mentira em memória; banco real só lido)\n\n${results.join('\n')}\n\n${fails ? fails + ' FALHA(S)' : 'TUDO OK'}\n`);
console.log(fails ? `\n${fails} falha(s)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
