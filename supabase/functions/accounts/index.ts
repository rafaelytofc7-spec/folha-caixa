// Edge Function "accounts": única porta para criar logins (usuário + senha) da banca.
// - bootstrap: primeiro cadastro (só funciona enquanto a banca não tem nenhuma conta) → vira ADMIN.
// - create_user / set_password: só o ADMIN (JWT do login + token do caixa aberto por ele).
// O cadastro público do Supabase Auth fica desligado; a chave service_role existe só aqui, no servidor.
import { createClient } from 'npm:@supabase/supabase-js@2';

const DOMAIN = 'folhacaixa.app';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, error: string) => json(status, { error, code });

const USER_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const checkCommon = (b: Record<string, unknown>) => {
  const name = String(b.name ?? '').trim();
  const username = String(b.username ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  const pin = b.pin == null || b.pin === '' ? null : String(b.pin);
  if (!name || name.length > 60) return { err: 'Informe o nome (até 60 letras).' };
  if (!USER_RE.test(username)) return { err: 'Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _ (sem espaço e sem acento).' };
  if (password.length < 8 || password.length > 72) return { err: 'A senha precisa ter pelo menos 8 caracteres.' };
  if (pin !== null && !/^\d{4}$/.test(pin)) return { err: 'O PIN precisa ter 4 dígitos.' };
  return { name, username, password, pin };
};
const pgErr = (e: { message?: string; hint?: string } | null) => {
  const code = e?.hint || 'ERRO';
  const status = code === 'CADASTRO_FECHADO' ? 403 : code === 'PROIBIDO' ? 403 : code === 'SEM_PIN' || code === 'SEM_LOGIN' ? 401 : code === 'USUARIO_EXISTE' ? 409 : 400;
  return fail(status, code, e?.message || 'Erro');
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'METODO', 'Use POST.');
  const url = Deno.env.get('SUPABASE_URL')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return fail(400, 'JSON', 'Corpo inválido.'); }
  const action = String(b.action ?? '');

  // quem está chamando (para ações de admin)
  const caller = async () => {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return null;
    const { data, error } = await admin.auth.getUser(jwt);
    return error ? null : data.user;
  };

  if (action === 'bootstrap') {
    const c = checkCommon(b);
    if ('err' in c) return fail(400, 'DADOS', c.err!);
    if (!c.pin) return fail(400, 'PIN_INVALIDO', 'Crie um PIN de 4 dígitos (usado para trocar de operador e autorizar).');
    const { data: open, error: e0 } = await admin.rpc('app_needs_setup');
    if (e0) return pgErr(e0);
    if (!open) return fail(403, 'CADASTRO_FECHADO', 'Cadastro fechado: a banca já tem administrador. Peça ao admin para criar seu usuário.');
    const { data: created, error: e1 } = await admin.auth.admin.createUser({
      email: `${c.username}@${DOMAIN}`, password: c.password, email_confirm: true, user_metadata: { username: c.username, name: c.name },
    });
    if (e1 || !created.user) {
      const exists = /already|registered|exists/i.test(e1?.message || '');
      return exists ? fail(409, 'USUARIO_EXISTE', 'Esse usuário já existe.') : fail(400, 'AUTH', e1?.message || 'Não deu para criar o login.');
    }
    const { data, error } = await admin.rpc('account_bootstrap', { p_auth_uid: created.user.id, p_name: c.name, p_username: c.username, p_pin: c.pin });
    if (error) { await admin.auth.admin.deleteUser(created.user.id); return pgErr(error); }
    return json(200, { ok: true, user: data });
  }

  if (action === 'create_user' || action === 'set_password') {
    const me = await caller();
    if (!me) return fail(401, 'SEM_LOGIN', 'Entre com usuário e senha.');
    const token = String(b.token ?? '');
    if (action === 'create_user') {
      const c = checkCommon(b);
      if ('err' in c) return fail(400, 'DADOS', c.err!);
      const role = String(b.role ?? 'operador');
      if (!['admin', 'gerente', 'operador'].includes(role)) return fail(400, 'DADOS', 'Papel inválido.');
      // confere admin ANTES de criar qualquer login
      const { error: ePre } = await admin.rpc('account_check_admin', { p_token: token, p_caller: me.id });
      if (ePre) return pgErr(ePre);
      const { data: created, error: e1 } = await admin.auth.admin.createUser({
        email: `${c.username}@${DOMAIN}`, password: c.password, email_confirm: true, user_metadata: { username: c.username, name: c.name },
      });
      if (e1 || !created.user) {
        const exists = /already|registered|exists/i.test(e1?.message || '');
        return exists ? fail(409, 'USUARIO_EXISTE', 'Esse usuário já existe.') : fail(400, 'AUTH', e1?.message || 'Não deu para criar o login.');
      }
      const { data, error } = await admin.rpc('account_create', {
        p_token: token, p_caller: me.id, p_auth_uid: created.user.id, p_name: c.name, p_username: c.username, p_role: role, p_pin: c.pin,
      });
      if (error) { await admin.auth.admin.deleteUser(created.user.id); return pgErr(error); }
      return json(200, { ok: true, user: data });
    }
    const password = String(b.password ?? '');
    if (password.length < 8 || password.length > 72) return fail(400, 'DADOS', 'A senha precisa ter pelo menos 8 caracteres.');
    const { data: target, error } = await admin.rpc('account_target', { p_token: token, p_caller: me.id, p_user_id: Number(b.user_id) });
    if (error) return pgErr(error);
    const { error: e2 } = await admin.auth.admin.updateUserById(String(target), { password });
    if (e2) return fail(400, 'AUTH', e2.message);
    return json(200, { ok: true });
  }

  return fail(400, 'ACAO', 'Ação desconhecida.');
});
