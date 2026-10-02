// Gera as capturas de tela em docs/prints usando o Chrome/Chromium instalado (playwright-core).
// Uso: npm run build && npm run prints   (CHROME=/caminho/do/chrome opcional)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'docs/prints');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folha-prints-'));
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

const srv = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(PORT), FOLHA_DB: path.join(tmp, 'prints.db') }, stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }

process.on('exit', () => { try { srv.kill(); } catch {} });
process.on('unhandledRejection', (e) => { console.error('FALHOU:', e); srv.kill(); process.exit(1); });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--font-render-hinting=none', '--lang=pt-BR'] });
async function session(width, height, prefix) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const shot = async (name) => { await sleep(350); await page.screenshot({ path: path.join(out, `${prefix}${name}.png`) }); console.log('📸', `${prefix}${name}.png`); };
  return { ctx, page, shot };
}
async function login(page, name, pin) {
  await page.goto(BASE + '/#/venda');
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await page.keyboard.type(pin, { delay: 40 });
  await page.waitForSelector('.header');
}

// ---------- 1366x768 ----------
{
  const { page, shot, ctx } = await session(1366, 768, '');
  await page.goto(BASE);
  await page.waitForSelector('.user-tile');
  await page.getByRole('button', { name: /Zé do Caixa/ }).click();
  await page.keyboard.type('11', { delay: 60 });
  await shot('01-login-pin');
  await page.keyboard.type('11', { delay: 60 });
  await page.waitForSelector('.header');
  await shot('02-venda-caixa-fechado');
  await page.getByRole('button', { name: 'Abrir caixa' }).first().click();
  await page.waitForSelector('.cart-empty .em');
  await sleep(300);
  // balança manda "1,250" pelo teclado + Enter, depois toca no atalho Tomate
  const search = page.locator('.searchbar input');
  await search.click(); await page.keyboard.type('1,250', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Tomate' }).first().click();
  await search.click(); await page.keyboard.type('0,860', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Banana prata' }).click();
  await page.locator('.tile', { hasText: 'Alface' }).click();
  await page.locator('.tile', { hasText: 'Alface' }).click();
  await search.click(); await page.keyboard.type('2,415', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Laranja' }).click();
  // pesagem pendente: toca Cebola sem peso -> barra "Pese a Cebola"
  await page.locator('.tile', { hasText: 'Cebola' }).click();
  await page.keyboard.type('0', { delay: 30 }); await page.keyboard.type('734', { delay: 60 });
  await shot('03-venda-carrinho-balanca');
  await page.keyboard.press('Enter');
  await sleep(200);
  await shot('04-venda-carrinho');
  await page.keyboard.press('F10');
  await page.waitForSelector('.pay-total');
  await page.locator('.methods button', { hasText: 'PIX' }).click();
  const amt = page.locator('.modal input.big');
  await amt.click(); await amt.fill(''); await page.keyboard.type('2000');
  await page.getByRole('button', { name: 'Lançar' }).click();
  await page.locator('.methods button', { hasText: 'Dinheiro' }).click();
  await page.locator('.bills .btn').nth(2).click();
  await shot('05-pagamento-misto');
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.waitForSelector('.receipt .title');
  await shot('06-cupom');
  await page.getByRole('button', { name: /Próximo freguês/ }).click();
  // segunda venda (fiado) para ter mais dados
  await search.click(); await page.keyboard.type('1,100', { delay: 30 }); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Batata' }).first().click();
  await page.locator('.tile', { hasText: 'Cenoura' }).click();
  await page.keyboard.press('F2'); await page.keyboard.type('650'); await page.keyboard.press('Enter');
  await page.keyboard.press('F10');
  await page.waitForFunction(() => document.querySelectorAll('.modal select option').length > 1);
  { const opts = await page.locator('.modal select option').allTextContents();
    await page.locator('.modal select').selectOption({ index: opts.findIndex((o) => o.includes('Marta')) }); }
  await page.locator('.methods button', { hasText: 'Fiado' }).click();
  await page.getByRole('button', { name: 'Lançar' }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.waitForSelector('.receipt .title');
  await page.getByRole('button', { name: /Próximo freguês/ }).click();
  // etiqueta de balança (EAN 2 + código 00101 + peso 001500 g + DV) -> Tomate 1,500 kg
  { const base = '200101001500'; let sum = 0; for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
    await search.click(); await page.keyboard.type(base + ((10 - (sum % 10)) % 10)); await page.keyboard.press('Enter'); }
  await page.waitForSelector('.cart-line');
  // pausar e retomar
  await page.keyboard.press('F6'); await page.waitForSelector('.modal input');
  await page.keyboard.type('Moça do boné'); await page.keyboard.press('Enter');
  await sleep(300);
  await page.keyboard.press('F8'); await page.waitForSelector('.modal .card');
  await shot('16-venda-pausada');
  await page.getByRole('button', { name: 'Retomar' }).last().click();
  await page.waitForSelector('.cart-line');
  await page.keyboard.press('F9'); await page.getByRole('button', { name: 'Limpar sacola' }).click();
  // cancelamento com PIN do gerente (operador logado)
  await page.goto(BASE + '/#/vendas');
  await page.locator('table.t tbody tr', { hasText: 'PIX' }).getByRole('button', { name: 'Cancelar' }).click();
  await page.keyboard.type('freguês desistiu');
  await page.getByRole('button', { name: 'Cancelar venda' }).click();
  await page.waitForSelector('.pin-dots');
  await page.keyboard.type('25', { delay: 50 });
  await shot('17-cancelamento-pin-gerente');
  await page.keyboard.type('80', { delay: 50 });
  await page.waitForSelector('.tag.bad');
  await shot('18-venda-cancelada');
  // caixa: sangria + fechamento
  await page.goto(BASE + '/#/caixa');
  await page.getByRole('button', { name: /Sangria/ }).click();
  await page.keyboard.type('5000'); await page.getByRole('button', { name: 'Confirmar' }).click();
  await sleep(300);
  await shot('07-caixa-aberto');
  await page.getByRole('button', { name: 'Fechar caixa' }).click();
  const eqs = page.locator('.modal button[title="Igual ao esperado"]');
  for (let i = 0; i < await eqs.count(); i++) await eqs.nth(i).click();
  const din = page.locator('.modal tbody tr').first().locator('input');
  await din.click(); await din.fill(''); await page.keyboard.type('4850'); // esperado R$ 50,00 -> faltou R$ 1,50
  await shot('08-caixa-fechamento');
  await page.getByRole('button', { name: /Fechar caixa e imprimir/ }).click();
  await page.waitForSelector('.receipt .title');
  await shot('09-caixa-relatorio-fechamento');
  await ctx.close();
}
// ---------- gerente: perda, relatório, cadastro ----------
{
  const { page, shot, ctx } = await session(1366, 768, '');
  await login(page, 'Dona Cida', '2580');
  await page.goto(BASE + '/#/estoque/perda');
  await page.locator('.card select.input').first().selectOption({ index: 21 });
  await page.locator('.tabs button', { hasText: 'Amadureceu' }).click();
  const q = page.locator('.card input.big'); await q.click(); await page.keyboard.type('1800');
  await page.getByRole('button', { name: 'Lançar perda' }).click();
  await sleep(400);
  await shot('10-estoque-perda');
  await page.goto(BASE + '/#/relatorios');
  await page.waitForSelector('.stat');
  await shot('11-relatorio');
  await page.goto(BASE + '/#/produtos');
  await page.locator('table.t tbody tr', { hasText: 'Tomate' }).first().click();
  await page.waitForSelector('.modal');
  await shot('12-cadastro-produto');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Atalhos da banca/ }).click();
  await shot('13-atalhos-config');
  await page.goto(BASE + '/#/fiado');
  await sleep(500);
  await shot('14-fiado-extrato');
  await page.goto(BASE + '/#/vendas');
  await sleep(400);
  await shot('15-vendas-do-dia');
  await ctx.close();
}
// ---------- tablet ----------
for (const [w, h] of [[1024, 768], [1180, 820]]) {
  const { page, shot, ctx } = await session(w, h, `tablet-${w}x${h}-`);
  await login(page, 'Zé do Caixa', '1111');
  await page.goto(BASE + '/#/caixa');
  const open = page.getByRole('button', { name: 'Abrir caixa' });
  if (await open.count()) { await open.first().click(); await sleep(300); }
  await page.goto(BASE + '/#/venda');
  const search = page.locator('.searchbar input');
  await search.click(); await page.keyboard.type('1,250'); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Tomate' }).first().click();
  await page.locator('.tile', { hasText: 'Alface' }).click();
  await search.click(); await page.keyboard.type('0,980'); await page.keyboard.press('Enter');
  await page.locator('.tile', { hasText: 'Maçã' }).click();
  await shot('venda');
  await page.keyboard.press('F10');
  await page.waitForSelector('.pay-total');
  await shot('pagamento');
  await ctx.close();
}
await browser.close();
srv.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Prints em', out);
