// QA da v3.1 (apagar produto + vendas importadas + lista real de produtos) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-v31.mjs [URL]   (padrão: URL publicada)
//
// NÃO cria conta nem grava nada no banco de verdade: o banco já tem a conta do dono. O site é o publicado (GitHub Pages),
// mas as chamadas ao Supabase são respondidas por um "banco de mentira" em memória dentro do teste, montado com uma
// LEITURA (select) dos produtos/categorias/configuração reais. Câmera falsa do Chrome com vídeo de código de barras.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = (process.argv[2] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/v3.1');
fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'web/.env.supabase'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SB = env.VITE_SUPABASE_URL; const REF = new URL(SB).hostname.split('.')[0];
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
  if (!r.ok) throw new Error('SQL ' + r.status); return r.json();
}
if (!process.env.SUPABASE_ACCESS_TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN (só para LER os produtos).'); process.exit(1); }
const SNAP = `select (select count(*) from auth.users)::int auth, (select count(*) from users)::int users, (select count(*) from products)::int products,
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
  return { products, cats: fx.cats, settings: { ...fx.settings }, saved: [], deleted: [], calls: [],
    usage: { 'Banana prata': { sales: 37, movements: 2, lots: 0, losses: 1 }, 'Tomate LV': { sales: 52, movements: 0, lots: 1, losses: 0 } } };
}
const session = { id: 1, terminal: 'QA-V3', status: 'ABERTO', opened_by: USER.id, opened_by_name: USER.name, opened_at: '2026-10-02 19:40:00', opening_float_cents: 10000, closed_at: null };
const status = (st) => ({ store: st.settings, terminal: 'QA-V3', user: USER, held_count: 0, alerts: { expiring: [], low_stock: [] },
  session: { session, by_method: [], sales_count: 0, sales_total_cents: 0, canceled_count: 0, canceled_total_cents: 0, ticket_medio_cents: 0 } });
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
      if (fn === 'report') return json(await realRpc(`report(${dateLit(body.p_from)}, ${dateLit(body.p_to)})`));
      if (fn === 'sale_get') return json(await realRpc(`sale_get(${Number(body.p_id)})`));
      if (fn === 'top_sellers' || fn === 'expiring_lots') return json([]);
      if (fn === 'settings_update') { Object.assign(st.settings, body.p_data); return json(st.settings); }
      if (fn === 'pin_users') return json([{ id: USER.id, name: USER.name, role: USER.role }]);
      return json([]);
    }
    if (p === '/rest/v1/v_products') { const rows = filterRows(st.products, url.searchParams); return json(single ? rows[0] : rows); }
    if (p === '/rest/v1/v_products_deleted') return json(st.deleted);
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
const shot2 = null;
const shot = async (page, name) => { await sleep(500); await page.screenshot({ path: path.join(out, name + '.png') }); console.log('📸', name); };
const cartText = (page) => page.locator('.cart-list').innerText().catch(() => '');
const wedge = async (page, code) => { await page.keyboard.type(code, { delay: 6 }); await page.keyboard.press('Enter'); };
const blur = (page) => page.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus(); });


// ---------- 1) versão publicada ----------
{
  const sw = await (await fetch(BASE + 'sw.js', { cache: 'no-store' })).text();
  const ver = sw.match(/const VERSION = '([^']+)'/)?.[1];
  check(ver === '3.1.0', `sw.js publicado: versão ${ver} (aparece "Atualizar agora" no app instalado)`);
}
const mgrProducts = fx.products.length;
check(mgrProducts === 64, `lista real de produtos (lida do banco): ${mgrProducts} visíveis (63 da lista do Rafael + 1 cadastrado por ele)`);

const rowOf = (page, name) => page.locator('table.t tbody tr').filter({ has: page.locator('td b', { hasText: new RegExp(`^\\S+ ${name.replace(/[()]/g, '\\$&')}$`) }) });
const waitToastGone = (page) => page.waitForSelector('.toast', { state: 'detached', timeout: 10000 }).catch(() => {});

// ---------- 2) computador 1366x768 (gerente/admin) ----------
{
  const browser = await launch(null);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { camera: false });
  await page.goto(BASE + '#/produtos'); await page.waitForSelector('table.t tbody tr');
  const n = await page.locator('table.t tbody tr').count();
  check(n === 64, `Produtos › Cadastro mostra ${n} produtos (os do Rafael)`);
  check(await page.locator('.row-del').count() === n, 'cada linha tem o botão 🗑 (gerente/admin)');
  check(await page.getByTestId('show-deleted').isVisible(), 'botão “🗑 Mostrar apagados” visível para gerente/admin');
  await shot(page, 'desk-01-produtos-lista-com-lixeira');

  // produto SEM histórico (Alface): pelo formulário
  await rowOf(page, 'Alface').click();
  await page.waitForSelector('[data-testid=product-delete]');
  ok('formulário de edição tem “🗑 Apagar produto”');
  await shot(page, 'desk-02-form-botao-apagar');
  await page.getByTestId('product-delete').click();
  await page.waitForSelector('[data-testid=delete-dialog] >> text=apagado de vez');
  const t1 = await page.getByTestId('delete-dialog').innerText();
  check(/Alface/.test(t1) && /nunca foi vendido/.test(t1) && /apagado de vez/.test(t1) && /fica livre/.test(t1), `confirmação (sem histórico): “${t1.replace(/\s+/g, ' ').trim()}”`);
  await shot(page, 'desk-03-confirmar-sem-historico');
  await page.keyboard.press('Escape'); await sleep(300);
  check(await page.getByTestId('delete-dialog').count() === 0 && await page.getByTestId('product-delete').isVisible(), 'Esc fecha só a confirmação (o cadastro continua aberto)');
  await page.getByTestId('product-delete').click();
  await page.getByTestId('confirm-delete').click();
  await page.waitForSelector('.toast >> text=Alface apagado.');
  await page.waitForSelector('.modal', { state: 'detached' });
  check(await rowOf(page, 'Alface').count() === 0 && !st.products.some((p) => p.name === 'Alface'), 'Alface sumiu da lista (apagado de vez)');

  // produto COM histórico (Banana prata): pela lixeira da lista
  await waitToastGone(page);
  await rowOf(page, 'Banana prata').locator('.row-del').click();
  await page.waitForSelector('[data-testid=delete-dialog] >> text=já tem histórico');
  const t2 = await page.getByTestId('delete-dialog').innerText();
  check(/37 vendas/.test(t2) && /continuam mostrando o nome/.test(t2) && /Preço do dia/.test(t2) && /Restaurar/.test(t2), `confirmação (com histórico): “${t2.replace(/\s+/g, ' ').trim()}”`);
  await shot(page, 'desk-04-confirmar-com-historico');
  await page.getByTestId('confirm-delete').click();
  await page.waitForSelector('.toast >> text=O histórico continua');
  check(await rowOf(page, 'Banana prata').count() === 0, 'Banana prata sumiu da lista (escondida, com histórico)');

  // some da venda: atalhos, busca, código
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  const tiles = await page.locator('.tile:not(.empty)').allInnerTexts();
  check(!tiles.some((t) => /Banana prata|Alface/.test(t)), `atalhos da venda sem Banana prata/Alface (${tiles.length} atalhos)`);
  await page.locator('.searchbar input').fill('banana'); await sleep(500);
  const sug = await page.locator('.tiles').innerText();
  check(!/Banana prata/.test(sug) && /Banana nanica/.test(sug), `busca “banana” na venda: acha as outras bananas, sem a prata (${sug.replace(/\s+/g, ' ').trim().slice(0, 120)}…)`);
  await page.locator('.searchbar input').fill('');
  await blur(page); await page.keyboard.type('201', { delay: 5 }); await page.keyboard.press('Enter');
  await sleep(600);
  check(!/Banana prata/.test(await cartText(page)), 'PLU 201 (código antigo da Banana prata) não coloca nada na sacola');
  await waitToastGone(page);
  await shot(page, 'desk-05-venda-atalhos-reais');

  // Preço do dia
  await page.goto(BASE + '#/produtos/precos'); await page.waitForSelector('.prices .price-in');
  const pd = await page.locator('.prices').innerText();
  check(!/Banana prata/.test(pd) && /Banana nanica/.test(pd), 'Preço do dia não mostra a Banana prata apagada');
  await shot(page, 'desk-06-preco-do-dia-dados-reais');

  // Mostrar apagados / Restaurar
  await page.goto(BASE + '#/produtos'); await page.waitForSelector('table.t tbody tr');
  await page.getByTestId('show-deleted').click();
  await page.waitForSelector('[data-testid=deleted-list]');
  check(/Banana prata/.test(await page.getByTestId('deleted-list').innerText()) && !/Alface/.test(await page.getByTestId('deleted-list').innerText()),
    'Mostrar apagados: Banana prata aparece (Alface não, foi apagado de vez)');
  await shot(page, 'desk-07-mostrar-apagados-restaurar');
  await page.getByRole('button', { name: '↩ Restaurar' }).click();
  await page.waitForSelector('.toast >> text=restaurado');
  await page.getByTestId('show-deleted').click();
  await page.waitForSelector('table.t tbody tr');
  check(await rowOf(page, 'Banana prata').count() === 1, 'Restaurar: Banana prata voltou para a lista');

  // vendas importadas (leitura real)
  await page.goto(BASE + '#/relatorios'); await page.waitForSelector('.stat');
  await page.locator('input[type=date]').first().fill('2026-09-01'); await page.locator('input[type=date]').nth(1).fill('2026-09-30');
  await page.waitForFunction(() => /56\.617,12/.test(document.querySelector('[data-testid=imported-note]')?.textContent ?? ''));
  const rep = await page.locator('.page').innerText();
  check(/R\$\s?56\.617,12/.test(rep) && /2459/.test(rep) && /Não informado/.test(rep) && /Sistema antigo/.test(rep), 'Relatórios setembro: R$ 56.617,12 em 2459 vendas importadas, “Não informado”, “Sistema antigo”');
  await shot(page, 'desk-08-relatorio-setembro-importadas');
  await page.goto(BASE + '#/vendas'); await page.waitForSelector('table.t tbody tr');
  const vl = await page.locator('.page').innerText();
  check(/Importada/.test(vl) && /Não informado/.test(vl) && !/Cancelar/.test(await page.locator('table.t').innerText()), 'Vendas de hoje: importadas marcadas “Importada”, pagamento “Não informado”, sem botão Cancelar');
  await shot(page, 'desk-09-vendas-importadas-hoje');
  await page.locator('table.t tbody tr').first().getByRole('button', { name: '🖨 Cupom' }).click();
  await page.waitForSelector('.modal >> text=VENDA IMPORTADA');
  ok('cupom de venda importada: “VENDA IMPORTADA DO SISTEMA ANTIGO”, só o total');
  await shot(page, 'desk-10-cupom-venda-importada');
  await page.keyboard.press('Escape');
  await page.goto(BASE + '#/hoje'); await page.waitForSelector('.kpis');
  await sleep(800);
  check(/importada/.test(await page.locator('.page').innerText()), 'Hoje: mostra as vendas importadas de hoje (“inclui N importada(s)”)');
  await shot(page, 'desk-11-hoje-com-importadas');
  await ctx.close(); await browser.close();
}

// ---------- 3) celular 412x915 ----------
{
  const browser = await launch(null);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { w: 412, h: 915, mobile: true, camera: false });
  await page.goto(BASE + '#/produtos'); await page.waitForSelector('table.t tbody tr');
  await shot(page, 'mob-01-produtos-lista');
  await rowOf(page, 'Tomate LV').click();
  await page.waitForSelector('[data-testid=product-delete]');
  await page.evaluate(() => document.querySelector('.modal-f')?.scrollIntoView({ block: 'end' }));
  await shot(page, 'mob-02-form-botao-apagar');
  await page.getByTestId('product-delete').click();
  await page.waitForSelector('[data-testid=delete-dialog] >> text=já tem histórico');
  await shot(page, 'mob-03-confirmar-com-historico');
  await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape'); await sleep(300);
  await rowOf(page, 'Vagem').locator('.row-del').click();
  await page.waitForSelector('[data-testid=delete-dialog] >> text=apagado de vez');
  await shot(page, 'mob-04-confirmar-sem-historico');
  check(st.calls.length === 0, 'celular: só abriu as confirmações (nada apagado)');
  await ctx.close(); await browser.close();
}

// ---------- 4) operador não vê apagar ----------
{
  USER = { id: 991, name: 'Operador QA', role: 'operador' };
  const browser = await launch(null);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { camera: false });
  await page.goto(BASE + '#/produtos'); await sleep(2500);
  const rows = await page.locator('table.t tbody tr').count();
  const dels = await page.locator('.row-del, [data-testid=product-delete], [data-testid=show-deleted]').count();
  if (rows) { await page.locator('table.t tbody tr').first().click(); await sleep(500); }
  const dels2 = await page.locator('[data-testid=product-delete]').count();
  check(dels === 0 && dels2 === 0, `operador: sem 🗑, sem “Apagar produto”, sem “Mostrar apagados” (tela de produtos ${rows ? 'aberta pelo link' : 'nem abre'})`);
  ok('no banco, product_delete/product_restore exigem gerente/admin (_require_role) — testado no banco com transação desfeita');
  await ctx.close(); await browser.close();
}

// ---------- o banco de verdade não mudou ----------
const [after] = await sql(SNAP);
// (ações do próprio Rafael no app durante o teste aparecem no audit_log com user_id dele; o QA só grava em memória)
const [mine] = await sql(`select coalesce(json_agg(json_build_object('id', id, 'action', action, 'user_id', user_id)), '[]') j from audit_log where created_at > now() - interval '15 minutes' and user_id is not null`);
if (mine.j.length) ok(`ações reais de usuários no app durante o QA (não são do teste): ${JSON.stringify(mine.j)}`);
check(JSON.stringify(after) === JSON.stringify(before), `banco real intacto durante o QA: ${JSON.stringify(after)}`);

fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA v3.1 em ${BASE}\n${new Date().toString()}\n(gravações respondidas por banco de mentira em memória; banco real só lido)\n\n${results.join('\n')}\n\n${fails ? fails + ' FALHA(S)' : 'TUDO OK'}\n`);
console.log(fails ? `\n${fails} falha(s)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
