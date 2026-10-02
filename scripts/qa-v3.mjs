// QA da v3 (leitor de código de barras + nome do app) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-v3.mjs [URL]   (padrão: URL publicada)
//
// NÃO cria conta nem grava nada no banco de verdade: o banco já tem a conta do dono. O site é o publicado (GitHub Pages),
// mas as chamadas ao Supabase são respondidas por um "banco de mentira" em memória dentro do teste, montado com uma
// LEITURA (select) dos produtos/categorias/configuração reais. Câmera falsa do Chrome com vídeo de código de barras.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { writeEan13Y4m } from './barcode-video.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = (process.argv[2] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/v3');
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
const [fx] = await sql(`select (select json_agg(v order by v.name) from v_products v) products, (select json_agg(c order by c.id) from categories c) cats, _settings_json() settings,
  (select count(*) from auth.users)::int auth_users, (select count(*) from products)::int n_products, (select count(*) from sales)::int n_sales`);
const before = { auth: fx.auth_users, products: fx.n_products, sales: fx.n_sales };
console.log('banco real antes:', before);

// ---------- 1) checagens sem login: manifest, título, service worker ----------
{
  const man = await (await fetch(BASE + 'manifest.webmanifest', { cache: 'no-store' })).json();
  check(man.name === 'Folha Caixa' && man.short_name === 'Folha Caixa', `manifest: name="${man.name}", short_name="${man.short_name}"`);
  const purposes = man.icons.map((i) => `${i.sizes}/${i.purpose}`);
  check(purposes.includes('192x192/any') && purposes.includes('512x512/any') && purposes.includes('192x192/maskable') && purposes.includes('512x512/maskable'), `manifest: ${man.icons.length} ícones (${purposes.join(', ')})`);
  check(man.theme_color && man.background_color, `manifest: theme_color ${man.theme_color}, background_color ${man.background_color}`);
  check(!(man.display_override ?? []).includes('window-controls-overlay'), `manifest: display_override ${JSON.stringify(man.display_override)} (sem window-controls-overlay → barra de título do Windows mostra o nome)`);
  for (const i of man.icons) { const r = await fetch(new URL(i.src, BASE)); if (!r.ok) bad(`ícone ${i.src} não abre (${r.status})`); }
  const html = await (await fetch(BASE, { cache: 'no-store' })).text();
  check(/<title>Folha Caixa<\/title>/.test(html), 'index.html: <title>Folha Caixa</title>');
  check(/name="application-name" content="Folha Caixa"/.test(html) && /name="apple-mobile-web-app-title" content="Folha Caixa"/.test(html), 'index.html: application-name e apple-mobile-web-app-title = Folha Caixa');
  const sw = await (await fetch(BASE + 'sw.js', { cache: 'no-store' })).text();
  const ver = sw.match(/const VERSION = '([^']+)'/)?.[1]; const cache = sw.match(/const CACHE = '([^']+)'/)?.[1];
  check(ver === '3.0.0', `sw.js: versão ${ver}, cache ${cache}`);
}

// ---------- banco de mentira (em memória) ----------
const USER = { id: 990, name: 'Teste QA', role: 'admin' };
function mockState() {
  const products = JSON.parse(JSON.stringify(fx.products));
  return { products, cats: fx.cats, settings: { ...fx.settings }, saved: [] };
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
      if (fn === 'settings_update') { Object.assign(st.settings, body.p_data); return json(st.settings); }
      if (fn === 'pin_users') return json([{ id: USER.id, name: USER.name, role: USER.role }]);
      return json([]);
    }
    if (p === '/rest/v1/v_products') { const rows = filterRows(st.products, url.searchParams); return json(single ? rows[0] : rows); }
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

const vidOvos = writeEan13Y4m('7891000004012', '/tmp/qa-ean-ovos.y4m');
const vidEtiqueta = writeEan13Y4m(scaleLabel('101', 1500), '/tmp/qa-ean-etiqueta.y4m');

// ---------- 2) computador 1366x768: leitor USB, etiqueta, desconhecido → cadastrar, câmera ----------
{
  const browser = await launch(vidOvos);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/venda');
  await page.waitForSelector('.searchbar .scan-btn');
  await page.waitForSelector('.tile:not(.empty)');
  check((await page.title()) === 'Folha Caixa', `título da página na venda: "${await page.title()}"`);
  await shot(page, 'desk-01-venda-botao-camera');

  // leitor USB (teclado) com o foco FORA da busca
  await blur(page);
  await wedge(page, '7891000004012');
  await page.waitForFunction(() => /Ovos brancos/.test(document.querySelector('.cart-list')?.textContent ?? ''));
  check((await page.locator('.searchbar input').inputValue()) === '', 'leitor USB fora da busca: Ovos brancos (EAN 7891000004012) entrou e a busca ficou limpa');

  // etiqueta de balança no leitor USB (peso)
  const lbl = scaleLabel('101', 1500);
  await blur(page);
  await wedge(page, lbl);
  await page.waitForFunction(() => /Tomate[\s\S]*1,500 kg/.test(document.querySelector('.cart-list')?.textContent ?? ''));
  ok(`etiqueta de balança ${lbl} pelo leitor USB: Tomate 1,500 kg na sacola`);

  // leitor com o cursor no campo da balança: não estraga o peso
  await page.keyboard.press('F4'); await sleep(200);
  await wedge(page, '7891000008010');
  await page.waitForFunction(() => /Água mineral/.test(document.querySelector('.cart-list')?.textContent ?? ''));
  check((await page.locator('input[aria-label="Peso em kg"]').inputValue()) === '0,000', 'leitor USB com o cursor no campo da balança: Água entrou e o peso continuou 0,000');

  // balança em modo teclado (rápida) continua sendo peso
  await blur(page);
  await wedge(page, '0,750');
  await sleep(300);
  check((await page.locator('input[aria-label="Peso em kg"]').inputValue()) === '0,750', 'balança em modo teclado (0,750 rápido + Enter) continua virando peso');
  await page.locator('.scale .btn', { hasText: 'Zerar' }).click();

  // pessoa digitando devagar na busca (sem ser leitor)
  await page.locator('.searchbar input').click();
  await page.keyboard.type('7891000005019', { delay: 110 }); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Feijão carioca/.test(document.querySelector('.cart-list')?.textContent ?? ''));
  ok('código digitado devagar na busca + Enter: Feijão carioca entrou');

  // código desconhecido → aviso com "Cadastrar produto" → cadastro com o código preenchido → entra na venda
  await blur(page);
  await wedge(page, '7899999999999');
  await page.waitForSelector('.toast .toast-act');
  check(/não cadastrado/.test(await page.locator('.toast').innerText()), `desconhecido: aviso “${(await page.locator('.toast span').innerText()).trim()}” com botão “Cadastrar produto”`);
  await shot(page, 'desk-04-codigo-desconhecido-cadastrar');
  await page.locator('.toast .toast-act').click();
  await page.waitForSelector('.modal [data-testid=ean]');
  check((await page.locator('.modal [data-testid=ean]').inputValue()) === '7899999999999', 'cadastro aberto na própria venda com o EAN 7899999999999 preenchido');
  await page.locator('.modal label.field', { hasText: 'Nome' }).locator('input').fill('Biscoito de polvilho');
  await page.locator('.modal label.field', { hasText: /^Preço por/ }).locator('input').fill('650');
  await page.locator('.modal label.field', { hasText: 'Estoque inicial' }).locator('input').fill('24');
  await shot(page, 'desk-05-cadastro-pelo-codigo');
  await page.getByRole('button', { name: 'Salvar produto' }).click();
  await page.waitForFunction(() => /Biscoito de polvilho/.test(document.querySelector('.cart-list')?.textContent ?? ''));
  check(st.saved.some((x) => x.ean === '7899999999999'), 'salvou (no banco de mentira) e o produto novo já entrou na sacola');

  // câmera: abre o leitor e lê o EAN do vídeo falso
  await page.locator('.searchbar .scan-btn').click();
  await page.waitForSelector('.scanner');
  ok('📷 abre o leitor da câmera');
  await page.waitForSelector('.scan-msg.ok', { timeout: 30000 });
  const msg = await page.locator('.scan-msg').innerText();
  check(/Ovos brancos/.test(msg), `câmera (vídeo falso com EAN 7891000004012): “${msg.trim()}”`);
  const eng = await page.locator('.scan-tools .small').innerText();
  ok(`motor usado no Chrome headless/Linux: ${eng.trim()} (BarcodeDetector ${await page.evaluate(() => 'BarcodeDetector' in window ? 'existe' : 'não existe')})`);
  await shot(page, 'desk-02-leitor-camera-lendo');
  await page.getByRole('button', { name: 'Concluir' }).click();
  await page.waitForSelector('.scanner', { state: 'detached' });
  const ct = await cartText(page);
  check(/Ovos brancos[\s\S]*2 dz/.test(ct), 'depois da câmera a sacola tem 2 dz de Ovos (1 do leitor USB + 1 da câmera)');
  await shot(page, 'desk-09-sacola-depois-das-leituras');

  // produto: campo de código de barras com 📷
  await page.goto(BASE + '#/produtos'); await page.waitForSelector('table.t tbody tr');
  await page.locator('table.t tbody tr', { hasText: 'Água mineral' }).click();
  await page.waitForSelector('.modal [data-testid=ean]');
  await page.locator('.modal [data-testid=ean]').fill('');
  await page.locator('.modal button[aria-label="Ler código de barras com a câmera"]').click();
  await page.waitForSelector('.scanner');
  await page.waitForSelector('.scanner', { state: 'detached', timeout: 30000 });
  const v = await page.locator('.modal [data-testid=ean]').inputValue();
  check(v === '7891000004012', `📷 no campo EAN do produto preencheu ${v}`);
  check(await page.locator('.warn-mini', { hasText: 'Ovos brancos' }).isVisible(), 'aviso no cadastro: “Esse código já está no produto Ovos brancos”');
  await page.locator('.modal [data-testid=ean]').fill('7891000008010');
  await page.waitForSelector('.toast', { state: 'detached', timeout: 10000 }).catch(() => {});
  await shot(page, 'desk-06-produto-campo-ean');
  await page.getByRole('button', { name: 'Voltar' }).click();

  // Config: testar etiqueta
  await page.goto(BASE + '#/config/loja'); await page.waitForSelector('[aria-label="Testar etiqueta de balança"]');
  await page.locator('[aria-label="Testar etiqueta de balança"]').fill(lbl);
  const t = await page.locator('[data-testid=scale-test]').innerText();
  check(/Tomate[\s\S]*1,500 kg/.test(t), `Config. › testar etiqueta ${lbl}: “${t.trim()}”`);
  await page.evaluate(() => document.querySelector('[data-testid=scale-test]')?.scrollIntoView({ block: 'center' }));
  await page.waitForSelector('.toast', { state: 'detached', timeout: 10000 }).catch(() => {});
  await shot(page, 'desk-07-config-etiqueta-balanca');
  // modo preço
  await page.locator('label.field', { hasText: 'Valor na etiqueta' }).locator('select').selectOption('preco');
  await page.locator('[aria-label="Testar etiqueta de balança"]').fill(scaleLabel('101', 1049));
  const t2 = await page.locator('[data-testid=scale-test]').innerText();
  check(/R\$\s?10,49[\s\S]*1,501 kg[\s\S]*R\$\s?10,49/.test(t2), `modo preço: etiqueta de R$ 10,49 → “${t2.trim()}”`);
  await ctx.close(); await browser.close();
}

// ---------- 3) câmera lendo etiqueta de balança ----------
{
  const browser = await launch(vidEtiqueta);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await page.locator('.searchbar .scan-btn').click();
  await page.waitForSelector('.scan-msg.ok', { timeout: 30000 });
  const msg = await page.locator('.scan-msg').innerText();
  check(/Tomate · 1,500 kg/.test(msg), `câmera lendo etiqueta de balança ${scaleLabel('101', 1500)}: “${msg.trim()}”`);
  await shot(page, 'desk-03-leitor-etiqueta-balanca');
  await ctx.close(); await browser.close();
}

// ---------- 4) celular 390x844 ----------
{
  const browser = await launch(vidOvos);
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { w: 390, h: 844, mobile: true });
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await shot(page, 'cel-01-venda-botao-camera');
  await page.locator('.searchbar .scan-btn').tap();
  await page.waitForSelector('.scan-msg.ok', { timeout: 30000 });
  check(/Ovos brancos/.test(await page.locator('.scan-msg').innerText()), 'celular: câmera leu o EAN e somou Ovos na sacola');
  await shot(page, 'cel-02-leitor-camera');
  await page.getByRole('button', { name: 'Concluir' }).tap();
  await page.waitForFunction(() => /1/.test(document.querySelector('.m-bar .m-bag')?.textContent ?? ''));
  ok('celular: barra verde da sacola mostra o item lido');
  await page.goto(BASE + '#/produtos'); await page.waitForSelector('table.t tbody tr');
  await page.locator('table.t tbody tr', { hasText: 'Ovos brancos' }).tap();
  await page.waitForSelector('.modal [data-testid=ean]');
  await shot(page, 'cel-03-produto-campo-ean');
  await ctx.close(); await browser.close();
}

// ---------- 5) sem permissão da câmera / sem câmera ----------
{
  const browser = await launch(vidOvos, { fakeUi: false }); // tem câmera, mas a permissão não foi dada
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st, { camera: false });
  await ctx.clearPermissions();
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await page.locator('.searchbar .scan-btn').click();
  await page.waitForSelector('.scan-state.err', { timeout: 20000 });
  const t = await page.locator('.scan-state.err').innerText();
  check(/permissão/i.test(t) && /Tentar de novo/.test(t), `câmera negada: “${t.split('\n').filter(Boolean).slice(1, 2).join(' ')}” + instruções + “Tentar de novo”`);
  await page.locator('[aria-label="Código digitado"]').fill('7891000004012');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.waitForSelector('.scan-msg.ok');
  ok('câmera negada: digitando o código na janela do leitor o produto entra');
  await page.locator('[aria-label="Código digitado"]').fill('');
  await shot(page, 'desk-08-camera-sem-permissao');
  await ctx.close(); await browser.close();
}
{
  const browser = await launch(null, { fakeUi: true }); // computador sem webcam
  const st = mockState();
  const { ctx, page } = await newCtx(browser, st);
  await page.goto(BASE + '#/venda'); await page.waitForSelector('.tile:not(.empty)');
  await page.locator('.searchbar .scan-btn').click();
  await page.waitForSelector('.scan-state.err', { timeout: 20000 });
  const t = await page.locator('.scan-state.err').innerText();
  check(/câmera/i.test(t), `sem webcam: “${t.split('\n').filter(Boolean).slice(1, 2).join(' ')}”`);
  await ctx.close(); await browser.close();
}

// ---------- 6) PWA de verdade (sem nada falso): service worker e título ----------
{
  const browser = await launch(null);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector('input[autocomplete=username], .header');
  const swv = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; const t = await (await fetch(r.active.scriptURL)).text(); return t.match(/const VERSION = '([^']+)'/)?.[1]; });
  check(swv === '3.0.0', `service worker ativo no site publicado: versão ${swv}`);
  check((await page.title()) === 'Folha Caixa', `título na tela de entrada: "${await page.title()}"`);
  const appName = await page.evaluate(() => document.querySelector('meta[name=application-name]')?.getAttribute('content'));
  check(appName === 'Folha Caixa', `meta application-name: ${appName}`);
  await ctx.close(); await browser.close();
}

// ---------- o banco de verdade não mudou ----------
const [after] = await sql('select (select count(*) from auth.users)::int auth, (select count(*) from products)::int products, (select count(*) from sales)::int sales');
check(after.auth === before.auth && after.products === before.products && after.sales === before.sales, `banco real intacto: contas ${after.auth}, produtos ${after.products}, vendas ${after.sales} (igual a antes)`);

fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA v3 em ${BASE}\n${new Date().toString()}\n(chamadas ao Supabase respondidas por banco de mentira em memória; banco real só lido)\n\n${results.join('\n')}\n\n${fails ? fails + ' FALHA(S)' : 'TUDO OK'}\n`);
console.log(fails ? `\n${fails} falha(s)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
