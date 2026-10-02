// Teste do fluxo principal contra o banco ONLINE (Supabase): RPCs reais, RLS real.
// Uso: SUPABASE_ACCESS_TOKEN=... npm run test:supabase
//  - lê a senha da conta da loja de .store_login (nunca versionado) e a chave pública de web/.env.supabase
//  - zera o banco para a semente antes e DEPOIS (reset_seed via Management API) → termina limpo
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'web/.env.supabase'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const login = Object.fromEntries(fs.readFileSync(path.join(root, '.store_login'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SB_URL = env.VITE_SUPABASE_URL; const KEY = env.VITE_SUPABASE_KEY;
const REF = new URL(SB_URL).hostname.split('.')[0];
const T = 'CAIXA-TESTE';

async function sql(query) {
  const tok = process.env.SUPABASE_ACCESS_TOKEN;
  if (!tok) throw new Error('Defina SUPABASE_ACCESS_TOKEN para o teste poder zerar o banco.');
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const sb = createClient(SB_URL, KEY, opts);
const anon = createClient(SB_URL, KEY, opts);
const tok = {};
async function rpc(fn, args) { const r = await sb.rpc(fn, args); if (r.error) { const e = new Error(r.error.message); e.code = r.error.hint || r.error.code; throw e; } return r.data; }
async function fails(p, code) {
  try { await p; } catch (e) { if (code) assert.equal(e.code, code, `esperava ${code}, veio ${e.code}: ${e.message}`); return e; }
  assert.fail(`deveria falhar${code ? ' com ' + code : ''}`);
}
const prod = async (code) => (await sb.from('products').select('*').eq('code', code).single()).data;

before(async () => {
  await sql('select reset_seed()');
  const { error } = await sb.auth.signInWithPassword({ email: login.email, password: login.password });
  assert.ifError(error);
});
after(async () => { await sql('select reset_seed()'); await sb.auth.signOut(); });

test('segurança: sem login não lê nem chama RPC; cadastro público desligado', async () => {
  const r = await anon.from('products').select('id').limit(1);
  assert.ok(r.error || (r.data ?? []).length === 0, 'anon não pode ler produtos');
  const p = await anon.rpc('pin_login', { p_user_id: 3, p_pin: '1111', p_terminal: T });
  assert.ok(p.error, 'anon não pode chamar pin_login');
  const s = await anon.auth.signUp({ email: `teste${Date.now()}@example.com`, password: 'SenhaForte!12345' });
  assert.ok(s.error, 'signup público deve estar desligado');
});

test('PIN: errado recusa, certo entra (operador, gerente, admin); hash não é legível', async () => {
  const bad = await rpc('pin_login', { p_user_id: 3, p_pin: '0000', p_terminal: T });
  assert.equal(bad.code, 'PIN_ERRADO');
  for (const [id, pin, role] of [[1, '1234', 'admin'], [2, '2580', 'gerente'], [3, '1111', 'operador']]) {
    const r = await rpc('pin_login', { p_user_id: id, p_pin: pin, p_terminal: T });
    assert.equal(r.user.role, role); tok[role] = r.token;
  }
  const pins = await sb.from('user_pins').select('*');
  assert.ok(pins.error || pins.data.length === 0, 'user_pins não pode ser lido');
  const w = await sb.from('products').update({ price_cents: 1 }).eq('code', '101').select();
  assert.ok(w.error || (w.data ?? []).length === 0, 'escrita direta em tabela deve ser bloqueada');
  assert.equal((await prod('101')).price_cents, 699);
  await fails(rpc('cash_open', { p_token: 'token-falso', p_terminal: T, p_float: 0 }), 'SEM_PIN');
});

let saleId = 0;
test('abrir caixa (um por terminal)', async () => {
  const s = await rpc('cash_open', { p_token: tok.operador, p_terminal: T, p_float: 10000 });
  assert.equal(s.session.status, 'ABERTO'); assert.equal(s.opening_float_cents, 10000);
  await fails(rpc('cash_open', { p_token: tok.operador, p_terminal: T, p_float: 0 }), 'CAIXA_JA_ABERTO');
});

test('vender 1,250 kg de tomate: PIX + dinheiro com troco, número sequencial, baixa estoque', async () => {
  const tomate = await prod('101');
  const sale = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: tomate.id, qty: 1250 }], payments: [{ method: 'pix', amount_cents: 500 }, { method: 'dinheiro', amount_cents: 1000 }] } });
  saleId = sale.id;
  assert.equal(sale.total_cents, 874); // 6,99 × 1,250 = 8,7375 → 8,74
  assert.equal(sale.change_cents, 626);
  assert.equal(sale.number, 1);
  assert.equal(sale.payments.find((p) => p.method === 'dinheiro').net_cents, 374);
  assert.equal(sale.fiscal.status, 'SIMULADO');
  assert.equal((await prod('101')).stock_qty, 40000 - 1250);
  const s2 = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: (await prod('301')).id, qty: 2000 }], payments: [{ method: 'debito', amount_cents: 700 }] } });
  assert.equal(s2.number, 2);
});

test('regras: estoque negativo, produto inativo, troco só em dinheiro, desconto precisa de gerente', async () => {
  const alho = await prod('115');
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: alho.id, qty: 999000 }], payments: [{ method: 'pix', amount_cents: 99999999 }] } }));
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: alho.id, qty: 9000 }], payments: [{ method: 'dinheiro', amount_cents: 99999 }] } }), 'ESTOQUE_INSUFICIENTE');
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: alho.id, qty: 100 }], payments: [{ method: 'pix', amount_cents: 1000 }] } }), 'PAGAMENTO');
  const pera = await prod('211');
  await rpc('product_save', { p_token: tok.gerente, p_id: pera.id, p_data: { ...pera, active: false } });
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: pera.id, qty: 1000 }], payments: [{ method: 'pix', amount_cents: 1290 }] } }), 'PRODUTO_INATIVO');
  await rpc('product_save', { p_token: tok.gerente, p_id: pera.id, p_data: { ...pera, active: true } });
  const data = { items: [{ product_id: pera.id, qty: 1000 }], total_discount: { type: 'pct', value: 2000 }, payments: [{ method: 'pix', amount_cents: 1032 }] };
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: data }), 'PRECISA_GERENTE');
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: { ...data, manager_pin: '1111' } }), 'PRECISA_GERENTE');
  const ok = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: { ...data, manager_pin: '2580' } });
  assert.equal(ok.total_cents, 1032); assert.equal(ok.discount_authorized_by, 2);
});

test('fila offline: mesmo client_uuid não duplica a venda', async () => {
  const banana = await prod('201');
  const data = { client_uuid: '6f1c1d7e-0000-4000-8000-00000000abcd', offline: true,
    items: [{ product_id: banana.id, qty: 1000 }], payments: [{ method: 'dinheiro', amount_cents: 649 }] };
  const a = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: data });
  const b = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: data });
  assert.equal(a.id, b.id); assert.equal(a.offline, true);
  assert.equal((await prod('201')).stock_qty, 40000 - 1000);
});

test('fiado: limite, lançamento e recebimento', async () => {
  const marta = (await sb.from('customers').select('*').eq('name', 'Dona Marta').single()).data;
  const queijo = await prod('601');
  const alho = await prod('115');
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: queijo.id, qty: 5000 }, { product_id: alho.id, qty: 5000 }], customer_id: marta.id,
    payments: [{ method: 'fiado', amount_cents: 21450 + 16495 }] } }), 'LIMITE_FIADO');
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: queijo.id, qty: 100 }], payments: [{ method: 'fiado', amount_cents: 429 }] } }), 'FIADO_SEM_CLIENTE');
  const big = await (async () => { try { await rpc('customer_charge', { p_token: tok.operador, p_id: marta.id, p_amount: 40000, p_note: 'teste', p_manager_pin: '2580' }); return null; } catch (e) { return e; } })();
  assert.ok(big && big.code === 'LIMITE_FIADO', 'lançamento acima do limite deve falhar');
  const sale = await rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: (await prod('401')).id, qty: 1000 }], customer_id: marta.id, payments: [{ method: 'fiado', amount_cents: 1190 }] } });
  assert.equal(sale.customer_balance_cents, 1190);
  await fails(rpc('customer_charge', { p_token: tok.operador, p_id: marta.id, p_amount: 500, p_note: 'x' }), 'PRECISA_GERENTE');
  await rpc('customer_charge', { p_token: tok.operador, p_id: marta.id, p_amount: 500, p_note: 'pão', p_manager_pin: '2580' });
  await rpc('customer_receive', { p_token: tok.operador, p_terminal: T, p_id: marta.id, p_amount: 1690, p_method: 'dinheiro', p_note: 'acerto' });
  const st = await rpc('customer_statement', { p_id: marta.id });
  assert.equal(st.customer.balance_cents, 0);
  assert.ok(st.entries.length >= 3);
});

test('perda com PIN do gerente baixa estoque', async () => {
  const mor = await prod('304');
  await fails(rpc('stock_loss', { p_token: tok.operador, p_data: { product_id: mor.id, qty: 2000, reason: 'estragou' } }), 'PRECISA_GERENTE');
  const r = await rpc('stock_loss', { p_token: tok.operador, p_data: { product_id: mor.id, qty: 2000, reason: 'estragou', note: 'mofou', manager_pin: '2580' } });
  assert.equal(r.balance, 18000);
  assert.equal(r.cost_cents, Math.round(574 * 2));
  const lots = (await sb.from('lots').select('*').eq('product_id', mor.id)).data;
  assert.equal(lots[0].qty_left, 18000); // consome lote (FEFO)
});

test('cancelar venda: precisa de gerente, estorna estoque e caixa', async () => {
  await fails(rpc('sale_cancel', { p_token: tok.operador, p_terminal: T, p_id: saleId, p_reason: 'cliente desistiu' }), 'PRECISA_GERENTE');
  const c = await rpc('sale_cancel', { p_token: tok.operador, p_terminal: T, p_id: saleId, p_reason: 'cliente desistiu', p_manager_pin: '2580' });
  assert.equal(c.status, 'CANCELADA');
  assert.equal((await prod('101')).stock_qty, 40000);
  await fails(rpc('sale_cancel', { p_token: tok.operador, p_terminal: T, p_id: saleId, p_reason: 'de novo', p_manager_pin: '2580' }));
});

test('sangria/suprimento e fechar caixa com conferência', async () => {
  await fails(rpc('cash_move', { p_token: tok.operador, p_terminal: T, p_kind: 'SANGRIA', p_amount: 9999999 }));
  await rpc('cash_move', { p_token: tok.operador, p_terminal: T, p_kind: 'SUPRIMENTO', p_amount: 2000, p_note: 'moedas' });
  const s = await rpc('cash_move', { p_token: tok.operador, p_terminal: T, p_kind: 'SANGRIA', p_amount: 5000, p_note: 'cofre' });
  const din = s.by_method.find((m) => m.method === 'dinheiro');
  // 100 fundo + 6,49 banana + 16,90 fiado recebido + 20 suprimento − 50 sangria (venda do tomate cancelada → estornada)
  assert.equal(din.expected_cents, 10000 + 649 + 1690 + 2000 - 5000);
  const closed = await rpc('cash_close', { p_token: tok.operador, p_terminal: T, p_counted: { dinheiro: din.expected_cents - 100 }, p_note: 'faltou 1 real' });
  assert.equal(closed.session.status, 'FECHADO');
  const d2 = closed.by_method.find((m) => m.method === 'dinheiro');
  assert.equal(d2.diff_cents, -100);
  await fails(rpc('sale_create', { p_token: tok.operador, p_terminal: T, p_data: {
    items: [{ product_id: (await prod('101')).id, qty: 1000 }], payments: [{ method: 'pix', amount_cents: 699 }] } }), 'CAIXA_FECHADO');
});

test('relatório do dia e auditoria', async () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
  const r = await rpc('report', { p_from: today, p_to: today });
  assert.equal(r.summary.canceled_count, 1);
  assert.ok(r.summary.sales_count >= 4);
  assert.ok(r.summary.loss_cost_cents > 0);
  const a = (await sb.from('audit_log').select('action')).data.map((x) => x.action);
  for (const k of ['LOGIN', 'LOGIN_FALHOU', 'VENDA', 'VENDA_CANCELADA', 'PERDA', 'CAIXA_ABERTURA', 'CAIXA_FECHAMENTO']) assert.ok(a.includes(k), `auditoria sem ${k}`);
  void p;
});
