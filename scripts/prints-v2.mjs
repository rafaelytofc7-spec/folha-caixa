// Capturas de todas as telas em 1366x768, 1024x768 e 390x844 (depois do redesenho), com o fluxo de PRIMEIRO ACESSO real:
// zera o banco → "Criar cadastro" (vira admin) → admin cria a equipe → vende → todas as telas → zera o banco de novo (ZERO contas).
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/prints-v2.mjs [pasta=after] [URL]
//   As senhas são aleatórias e ficam só na memória deste processo.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const folder = process.argv[2] || 'after';
const BASE = (process.argv[3] || 'https://rafaelytofc7-spec.github.io/folha-caixa/').replace(/\/?$/, '/');
const out = path.join(root, 'docs/prints/v2', folder);
fs.mkdirSync(out, { recursive: true });
const REF = 'cprtigvovwbmigxbosac';
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`SQL ${r.status} ${(await r.text()).slice(0, 200)}`); return r.json();
}
if (!process.env.SUPABASE_ACCESS_TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN (o script zera o banco antes e depois).'); process.exit(1); }
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = { name: 'Rafael', username: 'rafael', password: crypto.randomBytes(9).toString('base64url') + '7a', pin: '1234' };
const errors = [];

await sql('select reset_seed()');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--lang=pt-BR'] });

async function run(prefix, w, h, mobile, first) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' : undefined });
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => { errors.push(`${prefix} pageerror ${e.message}`); console.error(prefix, 'pageerror', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error(prefix, 'console', m.text().slice(0, 200)); });
  const shot = async (n) => { await sleep(600); await page.screenshot({ path: path.join(out, `${prefix}-${n}.png`) }); console.log('📸', `${folder}/${prefix}-${n}`); };
  const tap = (loc) => (mobile ? loc.tap() : loc.click());
  await page.goto(BASE);
  if (first) {
    await page.waitForSelector('text=Criar cadastro');
    await shot('00-primeiro-acesso');
    await page.getByLabel('Seu nome').fill(ADMIN.name);
    const pw = page.locator('input[autocomplete=new-password]');
    await pw.nth(0).fill(ADMIN.password); await pw.nth(1).fill(ADMIN.password);
    await page.getByLabel(/PIN de 4/).fill(ADMIN.pin);
    await shot('00b-cadastro-preenchido');
    await tap(page.getByRole('button', { name: /Criar cadastro e entrar/ }));
  } else {
    await page.waitForSelector('input[autocomplete=username]');
    await page.locator('input[autocomplete=username]').fill('');
    await shot('00-login');
    await page.locator('input[autocomplete=username]').fill(ADMIN.username);
    await page.locator('input[autocomplete=current-password]').fill(ADMIN.password);
    await tap(page.getByRole('button', { name: /^Entrar$/ }));
  }
  await page.waitForSelector('.header'); await sleep(1500);
  if (first) await shot('01-hoje-primeiro-dia');
  await page.goto(BASE + '#/venda'); await sleep(1200);
  const abrir = page.getByRole('button', { name: 'Abrir caixa' }).first();
  if (await abrir.isVisible().catch(() => false)) { await shot('02-venda-caixa-fechado'); await tap(abrir); await sleep(1500); }
  await shot('03-venda-vazia');
  if (!mobile) {
    const s = page.locator('.searchbar input');
    await s.click(); await page.keyboard.type('1,250'); await page.keyboard.press('Enter');
    await page.locator('.tile', { hasText: 'Tomate' }).first().click();
    await s.click(); await page.keyboard.type('0,860'); await page.keyboard.press('Enter');
    await page.locator('.tile', { hasText: 'Banana prata' }).first().click();
    await page.locator('.tile', { hasText: 'Alface' }).first().click();
    await page.locator('.tile', { hasText: 'Alface' }).first().click();
    await sleep(100); await shot('04-venda-sacola');
    await s.click(); await page.keyboard.type('maca');
    await shot('04c-busca-sem-acento');
    await page.keyboard.press('Escape');
    await page.keyboard.press('F10');
  } else {
    await tap(page.locator('.tile', { hasText: 'Tomate' }).first());
    await page.waitForSelector('.modal'); await page.keyboard.type('1250'); await shot('04a-peso'); await page.keyboard.press('Enter');
    await sleep(300);
    await tap(page.locator('.tile', { hasText: 'Alface' }).first());
    await tap(page.locator('.tile', { hasText: 'Banana prata' }).first());
    await page.waitForSelector('.modal'); await page.keyboard.type('860'); await page.keyboard.press('Enter');
    await sleep(250);
    await shot('04-venda-produtos');
    await tap(page.locator('.m-bar').first());
    await page.waitForSelector('.cart-line');
    await shot('04b-sacola');
    await tap(page.getByRole('button', { name: /^Receber/ }).first());
  }
  await page.waitForSelector('.pay-total');
  await tap(page.locator('.methods button', { hasText: 'PIX' }));
  const amt = page.locator('.modal input.big'); await amt.click(); await amt.fill(''); await page.keyboard.type('1000');
  await tap(page.getByRole('button', { name: 'Lançar' }));
  await tap(page.locator('.methods button', { hasText: 'Dinheiro' }));
  await tap(page.locator('.bills .btn').nth(1));
  await shot('05-pagamento');
  await tap(page.getByRole('button', { name: /Finalizar venda/ }));
  await page.waitForSelector('.receipt .title');
  await shot('06-cupom');
  await tap(page.getByRole('button', { name: /Próximo freguês/ }));
  await sleep(500);
  if (first) {
    // admin cria a equipe pela tela (usuário + senha + PIN)
    for (const [name, role, pin] of [['Joana', 'Gerente', '2580'], ['Beto', 'Operador', '1111']]) {
      await page.goto(BASE + '#/config/usuarios'); await page.waitForSelector('text=Usuários da banca'); await sleep(600);
      await page.getByRole('button', { name: '+ Novo usuário' }).click();
      await page.locator('.modal input').first().fill(name);
      await page.locator('.modal .tabs button', { hasText: role }).click();
      await page.locator('.modal input.pin-input').fill(pin);
      if (name === 'Joana') await shot('15a-novo-usuario');
      await page.getByRole('button', { name: 'Criar usuário' }).click();
      await page.waitForSelector('text=Usuário criado');
      if (name === 'Joana') await shot('15b-usuario-criado');
      await page.getByRole('button', { name: 'Pronto' }).click(); await sleep(500);
    }
    // compra com 2 itens de um fornecedor
    await page.goto(BASE + '#/compras/nova'); await page.waitForSelector('.psearch input'); await sleep(800);
    await page.locator('select.input').first().selectOption({ index: 1 });
    for (const [q, kg] of [['tomate', '20000'], ['limao', '8000']]) {
      await page.locator('.psearch input').fill(q); await sleep(300); await page.keyboard.press('Enter'); await sleep(200);
      await page.keyboard.type(kg);
    }
    await shot('17a-compra-nova');
    await page.getByRole('button', { name: /Lançar compra \(/ }).click(); await page.waitForSelector('text=lançada'); await sleep(500);
    await shot('17b-compra-lancada');
    // preço do dia
    await page.goto(BASE + '#/produtos/precos'); await page.waitForSelector('.price-row'); await sleep(600);
    const pi = page.locator('.price-row', { hasText: 'Melancia' }).locator('input');
    await pi.click(); await page.keyboard.type('299');
    const pi2 = page.locator('.price-row', { hasText: 'Morango' }).locator('input');
    await pi2.click(); await page.keyboard.type('790');
    await shot('18a-preco-do-dia');
    await page.getByRole('button', { name: 'Salvar preços do dia' }).click(); await sleep(1200);
  }
  const routes = [['hoje', '07-hoje'], ['caixa', '08-caixa'], ['vendas', '09-vendas'], ['fiado', '10-fiado'], ['estoque', '11-estoque-alertas'],
    ['compras/historico', '12-compras-historico'], ['compras/fornecedores', '13-fornecedores'], ['produtos', '14-produtos'], ['produtos/precos', '18-preco-do-dia'],
    ['relatorios', '19-relatorios'], ['config/usuarios', '15-usuarios'], ['config/conta', '16-minha-conta'], ['config/loja', '20-config']];
  for (const [r, n] of routes) {
    await page.goto(BASE + '#/' + r); await page.waitForSelector('.page, .sale'); await sleep(1600);
    await shot(n);
  }
  if (mobile) { await tap(page.locator('.bottom-nav button', { hasText: 'Mais' })); await shot('21-menu-mais'); await page.mouse.click(10, 10); }
  else { await page.locator('.user-btn').click(); await shot('21-menu-usuario'); await page.keyboard.press('Escape'); }
  // troca de operador por PIN
  await page.goto(BASE + '#/venda'); await sleep(800);
  if (mobile) { await tap(page.locator('.user-btn')); } else { await page.locator('.user-btn').click(); }
  await tap(page.getByRole('menuitem', { name: /Trocar operador/ }));
  await page.waitForSelector('.user-tile'); await sleep(600);
  await shot('22-trocar-operador-pin');
  // instalar (passo a passo quando o Chrome ainda não liberou a janela)
  const inst = page.locator('[data-install]').first();
  if (await inst.isVisible().catch(() => false)) { await tap(inst); await sleep(400); await shot('23-instalar'); }
  await ctx.close();
}
try {
  await run('desk', 1366, 768, false, true);
  await run('tab', 1024, 768, false, false);
  await run('cel', 390, 844, true, false);
} finally {
  await browser.close();
  await sql('select reset_seed()');
  const c = (await sql('select (select count(*) from auth.users)::int a, (select count(*) from users)::int u'))[0];
  console.log('reset_seed → contas no Auth:', c.a, '· usuários:', c.u);
  if (errors.length) { console.log('ERROS DE PÁGINA:', errors.length); process.exitCode = 1; }
}
