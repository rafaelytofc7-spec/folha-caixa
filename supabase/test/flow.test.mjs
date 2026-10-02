// Teste do fluxo principal contra o banco ONLINE (Supabase): RPCs reais, RLS real, Edge Function "accounts" real.
// Uso: SUPABASE_ACCESS_TOKEN=... npm run test:supabase
//  - cria contas TEMPORÁRIAS (senhas aleatórias só em memória) e apaga tudo no fim:
//    reset_seed antes e DEPOIS → o banco termina com ZERO contas (pronto para o primeiro cadastro de verdade)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'web/.env.supabase'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SB_URL = env.VITE_SUPABASE_URL; const KEY = env.VITE_SUPABASE_KEY;
const REF = new URL(SB_URL).hostname.split('.')[0];
const T = 'CAIXA-TESTE';
const pw = () => crypto.randomBytes(12).toString('base64url') + 'a9';
const sfx = crypto.randomBytes(3).toString('hex');
const ACC = { admin: { name: 'Admin Teste', username: `t-admin-${sfx}`, password: pw(), pin: '1234' },
  gerente: { name: 'Gerente Teste', username: `t-ger-${sfx}`, password: pw(), pin: '2580', role: 'gerente' },
  operador: { name: 'Operador Teste', username: `t-op-${sfx}`, password: pw(), pin: '1111', role: 'operador' } };
const email = (u) => `${u}@folhacaixa.app`;

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
const tok = {}; const ids = {};
async function rpc(fn, args, c = sb) { const r = await c.rpc(fn, args); if (r.error) { const e = new Error(r.error.message); e.code = r.error.hint || r.error.code; throw e; } return r.data; }
async function fails(p, code) {
  try { await p; } catch (e) { if (code) assert.equal(e.code, code, `esperava ${code}, veio ${e.code}: ${e.message}`); return e; }
  assert.fail(`deveria falhar${code ? ' com ' + code : ''}`);
}
const prod = async (code) => (await sb.from('products').select('*').eq('code', code).single()).data;
async function fn(body, jwt) {
  const r = await fetch(`${SB_URL}/functions/v1/accounts`, { method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${jwt || KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const jwtOf = async (c) => (await c.auth.getSession()).data.session?.access_token;
const counts = async () => (await sql(`select (select count(*) from auth.users)::int a, (select count(*) from users)::int u,
  (select count(*) from products where shortcut_pos is not null)::int sc, (select count(*) from sales)::int s`))[0];

before(async () => { await sql('select reset_seed()'); });
after(async () => {
  await sb.auth.signOut().catch(() => {});
  await sql('select reset_seed()');
  const c = await counts();
  assert.deepEqual([c.a, c.u, c.s, c.sc], [0, 0, 0, 24], 'banco deve terminar sem contas, sem vendas e com 24 atalhos');
});

test('banco zerado: sem contas, 24 atalhos, cadastro aberto só para o primeiro', async () => {
  const c = await counts();
  assert.deepEqual([c.a, c.u, c.sc], [0, 0, 24]);
  assert.equal(await rpc('app_needs_setup', {}, anon), true);
});

test('segurança: sem login não lê nem chama RPC; signup público do Supabase desligado; account_* só no servidor', async () => {
  const r = await anon.from('products').select('id').limit(1);
  assert.ok(r.error || (r.data ?? []).length === 0, 'anon não pode ler produtos');
  assert.ok((await anon.rpc('pin_login', { p_user_id: 1, p_pin: '1111', p_terminal: T })).error, 'anon não pode chamar pin_login');
  assert.ok((await anon.auth.signUp({ email: `x${sfx}@folhacaixa.app`, password: 'SenhaForte!12345' })).error, 'signup público deve estar desligado');
  assert.ok((await anon.rpc('account_bootstrap', { p_auth_uid: crypto.randomUUID(), p_name: 'x', p_username: 'xxx', p_pin: '1234' })).error,
    'account_bootstrap não pode ser chamado do navegador');
  const bad = await fn({ action: 'bootstrap', name: 'X', username: 'Com Espaço', password: '12345678', pin: '1234' });
  assert.equal(bad.status, 400);
});

test('primeiro cadastro vira ADMIN; depois o cadastro fecha', async () => {
  const r = await fn({ action: 'bootstrap', ...ACC.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'admin');
  assert.equal(await rpc('app_needs_setup', {}, anon), false);
  const again = await fn({ action: 'bootstrap', name: 'Intruso', username: `t-intruso-${sfx}`, password: pw(), pin: '9999' });
  assert.equal(again.status, 403); assert.equal(again.body.code, 'CADASTRO_FECHADO');
  assert.equal((await counts()).a, 1, 'o intruso não pode ter ficado no Auth');
  // entra com usuário + senha (e-mail interno) e abre o caixa sem PIN
  assert.ifError((await sb.auth.signInWithPassword({ email: email(ACC.admin.username), password: 'senha-errada' })).error ? null : new Error('senha errada entrou'));
  const { error } = await sb.auth.signInWithPassword({ email: email(ACC.admin.username), password: ACC.admin.password });
  assert.ifError(error);
  const me = await rpc('self_login', { p_terminal: T });
  assert.equal(me.user.role, 'admin'); assert.equal(me.user.username, ACC.admin.username);
  tok.admin = me.token; ids.admin = me.user.id;
});

test('admin cria gerente e operador (usuário + senha + PIN); outros não criam', async () => {
  const jwt = await jwtOf(sb);
  for (const k of ['gerente', 'operador']) {
    const r = await fn({ action: 'create_user', token: tok.admin, ...ACC[k] }, jwt);
    assert.equal(r.status, 200, JSON.stringify(r.body)); ids[k] = r.body.user.id;
  }
  const dup = await fn({ action: 'create_user', token: tok.admin, ...ACC.operador, name: 'Dup' }, jwt);
  assert.equal(dup.status, 409);
  assert.equal((await fn({ action: 'create_user', token: tok.admin, name: 'Sem login', username: `t-x-${sfx}`, password: pw(), role: 'operador' })).status, 401,
    'sem o JWT do login não cria');
  // operador entra com a própria senha em outro aparelho e tenta criar usuário → proibido
  const op = createClient(SB_URL, KEY, opts);
  assert.ifError((await op.auth.signInWithPassword({ email: email(ACC.operador.username), password: ACC.operador.password })).error);
  const opTok = (await rpc('self_login', { p_terminal: 'CEL-OP' }, op)).token;
  const no = await fn({ action: 'create_user', token: opTok, name: 'Hack', username: `t-hack-${sfx}`, password: pw(), role: 'admin' }, await jwtOf(op));
  assert.equal(no.status, 403); assert.equal(no.body.code, 'PROIBIDO');
  // token do admin com JWT do operador também não serve
  assert.equal((await fn({ action: 'create_user', token: tok.admin, name: 'Hack', username: `t-hack2-${sfx}`, password: pw(), role: 'admin' }, await jwtOf(op))).status, 401);
  // admin redefine a senha do operador
  const np = pw();
  assert.equal((await fn({ action: 'set_password', token: tok.admin, user_id: ids.operador, password: np }, jwt)).status, 200);
  assert.ok((await op.auth.signInWithPassword({ email: email(ACC.operador.username), password: ACC.operador.password })).error, 'senha antiga não entra mais');
  assert.ifError((await op.auth.signInWithPassword({ email: email(ACC.operador.username), password: np })).error);
  await op.auth.signOut();
  const list = await rpc('users_list', {});
  assert.deepEqual(list.map((u) => u.role), ['admin', 'gerente', 'operador']);
  assert.ok(list.every((u) => u.has_login && u.has_pin));
  assert.equal((await counts()).a, 3);
});

test('PIN: troca rápida de operador; errado recusa; hash não é legível', async () => {
  const users = await rpc('pin_users', {});
  assert.equal(users.length, 3);
  assert.equal((await rpc('pin_login', { p_user_id: ids.operador, p_pin: '0000', p_terminal: T })).code, 'PIN_ERRADO');
  for (const k of ['gerente', 'operador']) {
    const r = await rpc('pin_login', { p_user_id: ids[k], p_pin: ACC[k].pin, p_terminal: T });
    assert.equal(r.user.role, k); tok[k] = r.token;
  }
  const pins = await sb.from('user_pins').select('*');
  assert.ok(pins.error || pins.data.length === 0, 'user_pins não pode ser lido');
  const w = await sb.from('products').update({ price_cents: 1 }).eq('code', '101').select();
  assert.ok(w.error || (w.data ?? []).length === 0, 'escrita direta em tabela deve ser bloqueada');
  assert.equal((await prod('101')).price_cents, 699);
  await fails(rpc('cash_open', { p_token: 'token-falso', p_terminal: T, p_float: 0 }), 'SEM_PIN');
  await fails(rpc('user_save', { p_token: tok.admin, p_id: null, p_data: { name: 'x', role: 'operador', pin: '1212' } }));
});

test('fornecedor, entrada de compra com vários itens (tudo ou nada) e preço do dia', async () => {
  const sups = (await sb.from('suppliers').select('*').order('id')).data;
  assert.equal(sups.length, 2);
  await fails(rpc('supplier_save', { p_token: tok.operador, p_id: null, p_data: { name: 'X' } }), 'PROIBIDO');
  const s = await rpc('supplier_save', { p_token: tok.gerente, p_id: null, p_data: { name: 'Sítio Esperança', phone: '(11) 95555-0000' } });
  const [tom, ovo] = [await prod('107'), await prod('110')];
  const r = await rpc('purchase_entry', { p_token: tok.gerente, p_data: { supplier_id: s.id, note: 'NF 123', items: [
    { product_id: tom.id, qty: 20000, unit_cost_cents: 380 },
    { product_id: ovo.id, qty: 10000, unit_cost_cents: 650, lot_code: 'L-CHU-40', expiry_date: '2099-01-01' }] } });
  assert.equal(r.items_count, 2); assert.equal(r.total_cents, 380 * 20 + 650 * 10);
  assert.equal((await prod('107')).stock_qty, tom.stock_qty + 20000);
  assert.equal((await prod('110')).cost_cents, 650);
  const pu = (await sb.from('v_purchases').select('*').eq('id', r.id).single()).data;
  assert.equal(pu.supplier_name, 'Sítio Esperança');
  const mv = (await sb.from('v_stock_movements').select('*').eq('ref_type', 'compra').eq('ref_id', r.id)).data;
  assert.equal(mv.length, 2); assert.ok(mv.every((m) => m.supplier_name === 'Sítio Esperança'));
  await fails(rpc('purchase_entry', { p_token: tok.gerente, p_data: { supplier_id: s.id, items: [{ product_id: tom.id, qty: 1000 }, { product_id: 999999, qty: 1 }] } }), 'NAO_ENCONTRADO');
  assert.equal((await prod('107')).stock_qty, tom.stock_qty + 20000, 'compra com erro não pode deixar nada pela metade');
  await fails(rpc('prices_update', { p_token: tok.operador, p_items: [] }), 'PROIBIDO');
  const mel = await prod('209'); const lar = await prod('204');
  const pr = await rpc('prices_update', { p_token: tok.gerente, p_items: [{ id: mel.id, price_cents: 299 }, { id: lar.id, price_cents: lar.price_cents }] });
  assert.equal(pr.changed, 1); assert.equal((await prod('209')).price_cents, 299);
  await rpc('prices_update', { p_token: tok.gerente, p_items: [{ id: mel.id, price_cents: mel.price_cents }] });
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
  for (const k of ['PRIMEIRO_ACESSO', 'USUARIO_CRIADO', 'SENHA_REDEFINIDA', 'COMPRA_ENTRADA', 'PRECOS_DO_DIA', 'FORNECEDOR_CRIADO', 'LOGIN', 'LOGIN_FALHOU', 'VENDA', 'VENDA_CANCELADA', 'PERDA', 'CAIXA_ABERTURA', 'CAIXA_FECHAMENTO']) assert.ok(a.includes(k), `auditoria sem ${k}`);
  void p;
});
