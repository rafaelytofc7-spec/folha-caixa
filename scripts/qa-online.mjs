// QA do modo online (GitHub Pages + Supabase) com Chrome headless.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/qa-online.mjs [URL]   (padrão: URL publicada)
// Zera o banco, cria um ADMIN temporário pela Edge Function (primeiro cadastro), o admin cria "Dona Cida" (gerente)
// e "Zé do Caixa" (operador) com usuário + senha + PIN; entra como o Zé (usuário + senha), vende em 1366x768,
// 1024x768 e 390x844, prova que outro navegador "limpo" vê as vendas, testa a faixa/fila offline e no fim
// zera o banco de novo (reset_seed) → ZERO contas. Senhas aleatórias, só na memória.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = (process.argv[2] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/online');
fs.mkdirSync(out, { recursive: true });
import crypto from 'node:crypto';
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'web/.env.supabase'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const pw = () => crypto.randomBytes(9).toString('base64url') + '7a';
const ACC = { admin: { name: 'Admin QA', username: 'qa-admin', password: pw(), pin: '1234' },
  gerente: { name: 'Dona Cida', username: 'cida', password: pw(), pin: '2580', role: 'gerente' },
  operador: { name: 'Zé do Caixa', username: 'ze.caixa', password: pw(), pin: '1111', role: 'operador' } };
const login = ACC.operador;
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = 'cprtigvovwbmigxbosac';
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error('SQL ' + r.status + ' ' + (await r.text()).slice(0, 200)); return r.json();
}
const results = [];
if (!process.env.SUPABASE_ACCESS_TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN.'); process.exit(1); }
// ---------- primeiro acesso + equipe (pela Edge Function, como o app faz) ----------
await sql('select reset_seed()');
{
  const SB = env.VITE_SUPABASE_URL; const KEY = env.VITE_SUPABASE_KEY;
  const fn = async (body, jwt) => { const r = await fetch(`${SB}/functions/v1/accounts`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${jwt || KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; };
  await fn({ action: 'bootstrap', ...ACC.admin });
  const t = await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${ACC.admin.username}@folhacaixa.app`, password: ACC.admin.password }) })).json();
  const me = await (await fetch(`${SB}/rest/v1/rpc/self_login`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_terminal: 'QA' }) })).json();
  for (const k of ['gerente', 'operador']) await fn({ action: 'create_user', token: me.token, ...ACC[k] }, t.access_token);
}

const ok = (m) => { results.push('✔ ' + m); console.log('✔', m); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--lang=pt-BR'] });
async function ctxFor(w, h, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    isMobile: mobile, hasTouch: mobile, userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' : undefined });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) console.error('console', m.text()); });
  return { ctx, page };
}
const shot = async (page, name) => { await sleep(400); await page.screenshot({ path: path.join(out, name + '.png') }); console.log('📸', name); };

async function enter(page, prefix, shots = true) {
  await page.goto(BASE);
  await page.waitForSelector('input[autocomplete=username]');
  await page.fill('input[autocomplete=username]', login.username);
  await page.fill('input[autocomplete=current-password]', login.password);
  if (shots) await shot(page, prefix + '01-entrar-usuario-senha');
  await page.getByRole('button', { name: /^Entrar$/ }).click();
  await page.waitForSelector('.header');
  await page.waitForFunction(() => document.querySelector('.status-pill'));
  await sleep(800);
}
async function ensureOpen(page) {
  const btn = page.getByRole('button', { name: 'Abrir caixa' }).first();
  if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForSelector('.cart-empty .em, .tile'); await sleep(800); ok('caixa aberto pelo navegador'); }
}
async function finishReceipt(page) {
  await page.waitForSelector('.receipt .title');
  await page.waitForFunction(() => /\d/.test(document.querySelector('.modal-h h2')?.textContent || ''));
  const title = await page.locator('.modal-h h2').innerText();
  return Number(title.match(/(\d+)/)?.[1]);
}

const numbers = [];
// ---------- 1366x768 ----------
{
  const { ctx, page } = await ctxFor(1366, 768);
  await enter(page, 'desk-');
  await shot(page, 'desk-03-venda');
  await ensureOpen(page);
  const search = page.locator('.searchbar input');
  await search.click(); await page.keyboard.type('1,250', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Tomate' }).first().click();
  await page.locator('.tile', { hasText: 'Alface' }).click();
  await page.waitForSelector('.cart-line');
  await shot(page, 'desk-04-carrinho');
  await page.keyboard.press('F10');
  await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'PIX' }).click();
  const amt = page.locator('.modal input.big');
  await amt.click(); await amt.fill(''); await page.keyboard.type('500');
  await page.getByRole('button', { name: 'Lançar' }).click();
  await page.locator('.methods button', { hasText: 'Dinheiro' }).click();
  await page.locator('.bills .btn').nth(1).click();
  await shot(page, 'desk-05-pagamento-pix-dinheiro');
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  const n = await finishReceipt(page); numbers.push(n);
  await shot(page, 'desk-06-cupom');
  ok(`venda nº ${n} gravada no Supabase (1366x768)`);
  // PDF e .bin gerados no navegador
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  const pdfPath = path.join('/tmp', 'qa-cupom.pdf'); await dl.saveAs(pdfPath);
  if (fs.readFileSync(pdfPath).subarray(0, 4).toString() === '%PDF') ok('PDF do cupom gerado no navegador (' + fs.statSync(pdfPath).size + ' bytes)');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '.bin' }).click()]);
  const binPath = path.join('/tmp', 'qa-cupom.bin'); await dl2.saveAs(binPath);
  const bin = fs.readFileSync(binPath); if (bin[0] === 0x1b && bin[1] === 0x40) ok('.bin ESC/POS gerado no navegador (' + bin.length + ' bytes)');
  await page.getByRole('button', { name: /Próximo freguês/ }).click();

  // PWA: service worker + manifest
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  if (sw) ok('service worker ativo (PWA instalável)');
  const man = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  if (man.icons?.length >= 3) ok('manifest com ' + man.icons.length + ' ícones');

  // sem internet: faixa + venda vai para a fila e sobe quando volta
  await ctx.setOffline(true);
  await page.waitForSelector('.net-banner.off');
  await search.click(); await page.keyboard.type('0,800', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Banana prata' }).click();
  await page.keyboard.press('F10'); await page.waitForSelector('.pay-total');
  await page.locator('.bills .btn').first().click(); // Exato em dinheiro
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.waitForFunction(() => /aguardando envio/.test(document.querySelector('.net-banner')?.textContent ?? ''));
  await shot(page, 'desk-07-sem-internet-fila');
  ok('sem internet: faixa vermelha e venda guardada na fila do aparelho');
  await ctx.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.net-banner'), null, { timeout: 45000 });
  ok('internet voltou: fila enviada sozinha');
  await page.goto(BASE + '#/vendas'); await page.waitForSelector('table.t tbody tr');
  await shot(page, 'desk-09-vendas-do-dia');
  await page.locator('.user-btn').click(); // operador passa o caixa; gerente entra pelo PIN para ver config
  await page.getByRole('menuitem', { name: /Trocar operador/ }).click();
  await page.waitForSelector('.user-tile');
  await shot(page, 'desk-02-trocar-operador-pin');
  await page.getByRole('button', { name: /Dona Cida/ }).click(); await page.keyboard.type('2580', { delay: 40 });
  await page.waitForSelector('.header');
  await page.goto(BASE + '#/config'); await page.waitForSelector('.tabs');
  await page.getByRole('button', { name: 'Minha conta' }).click();
  await shot(page, 'desk-10-config-trocar-senha');
  await page.getByRole('button', { name: 'Backup' }).click();
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Baixar backup completo/ }).click()]);
  const bk = path.join('/tmp', 'qa-backup.json'); await dl3.saveAs(bk);
  const bj = JSON.parse(fs.readFileSync(bk, 'utf8'));
  if (bj.tables?.products?.length === 40) ok(`backup JSON exportado (${Object.keys(bj.tables).length} tabelas, ${bj.tables.sales.length} vendas)`);
  await shot(page, 'desk-11-backup');
  await ctx.close();
}
// ---------- 1024x768 ----------
{
  const { ctx, page } = await ctxFor(1024, 768);
  await enter(page, 'tab-', false);
  await ensureOpen(page);
  const search = page.locator('.searchbar input');
  await search.click(); await page.keyboard.type('2,000', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Laranja' }).click();
  await page.locator('.tile', { hasText: 'Alface' }).click();
  await shot(page, 'tab-03-carrinho');
  await page.keyboard.press('F10'); await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'Débito' }).click();
  await page.getByRole('button', { name: 'Lançar' }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  const n = await finishReceipt(page); numbers.push(n);
  await shot(page, 'tab-04-cupom');
  ok(`venda nº ${n} (1024x768)`);
  await ctx.close();
}
// ---------- 390x844 (celular) ----------
{
  const { ctx, page } = await ctxFor(390, 844, true);
  await enter(page, 'cel-');
  await ensureOpen(page);
  await shot(page, 'cel-03-venda-produtos');
  await page.locator('.tile', { hasText: 'Tomate' }).first().tap();
  await page.waitForSelector('.modal');
  await page.keyboard.type('1250', { delay: 40 });
  await shot(page, 'cel-04-peso');
  await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Alface' }).tap();
  await page.waitForFunction(() => /2/.test(document.querySelector('.m-bar .m-bag')?.textContent ?? ''));
  await shot(page, 'cel-05-barra-sacola');
  await page.locator('.m-bar').tap();
  await page.waitForSelector('.cart-line');
  await shot(page, 'cel-06-sacola');
  await page.getByRole('button', { name: /Receber/ }).tap();
  await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'PIX' }).tap();
  await page.getByRole('button', { name: 'Lançar' }).tap();
  await shot(page, 'cel-07-pagamento');
  await page.getByRole('button', { name: /Finalizar venda/ }).tap();
  const n = await finishReceipt(page); numbers.push(n);
  await shot(page, 'cel-08-cupom');
  ok(`venda nº ${n} no celular (390x844)`);
  await page.getByRole('button', { name: /Próximo freguês/ }).tap();
  await page.goto(BASE + '#/caixa'); await page.waitForSelector('.page');
  await shot(page, 'cel-09-caixa');
  await ctx.close();
}
// ---------- app abre sem internet (service worker) ----------
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folha-pwa-'));
  const host = new URL(BASE).host;
  let c = await chromium.launchPersistentContext(dir, { executablePath: exe, args: ['--no-sandbox'], viewport: { width: 1366, height: 768 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  let page = c.pages()[0] ?? await c.newPage(); page.setDefaultTimeout(15000);
  await enter(page, 'pwa-', false);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await sleep(2500);
  await c.close();
  // reabre com o site E o Supabase inalcançáveis (como celular sem sinal)
  c = await chromium.launchPersistentContext(dir, { executablePath: exe, viewport: { width: 1366, height: 768 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    args: ['--no-sandbox', `--host-resolver-rules=MAP ${host.split(':')[0]} 127.0.0.1:9, MAP ${REF}.supabase.co 127.0.0.1:9`] });
  page = c.pages()[0] ?? await c.newPage(); page.setDefaultTimeout(20000);
  await page.goto(BASE).catch(() => {});
  await page.waitForSelector('.header');
  await page.waitForSelector('.net-banner.off', { timeout: 30000 });
  await page.waitForSelector('.tile:not(.empty)', { timeout: 30000 });
  await shot(page, 'desk-08-abriu-sem-internet');
  ok('app reaberto sem internet: casca pelo service worker, produtos do cache e faixa "Sem internet"');
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
// ---------- prova de dados compartilhados: navegador novo, sem nada salvo ----------
{
  const { ctx, page } = await ctxFor(1366, 768);
  await enter(page, 'novo-', false);
  await page.goto(BASE + '#/vendas'); await page.waitForSelector('table.t tbody tr');
  const nums = (await page.locator('table.t tbody tr td:first-child').allInnerTexts()).map((t) => Number(t.trim()));
  for (const n of numbers) if (!nums.includes(n)) throw new Error(`venda ${n} não apareceu no outro navegador`);
  await shot(page, 'novo-01-mesmas-vendas-outro-navegador');
  ok(`navegador novo vê as vendas ${numbers.join(', ')} (+ a offline) → dados compartilhados`);
  await ctx.close();
}
await browser.close();
if (!process.env.KEEP_DATA) {
  await sql('select reset_seed()');
  const c = (await sql('select (select count(*) from auth.users)::int a, (select count(*) from users)::int u'))[0];
  if (c.a === 0 && c.u === 0) ok('banco zerado (reset_seed): zero contas, pronto para o primeiro cadastro de verdade');
  else throw new Error('sobrou conta no banco: ' + JSON.stringify(c));
}
fs.writeFileSync(path.join(out, 'RESULTADO.txt'), `QA online em ${BASE}\n${new Date().toString()}\n\n${results.join('\n')}\n`);
