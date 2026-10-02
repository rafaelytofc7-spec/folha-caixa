// Contas do modo online: usuário + senha. O usuário "joao" é o e-mail interno joao@folhacaixa.app
// no Supabase Auth (ninguém recebe e-mail). Contas só são criadas pela Edge Function "accounts".
import { sb, SB_URL, SB_KEY } from './client';
import { ApiError, getToken, getTerminal, setToken } from '../api';

export const DOMAIN = 'folhacaixa.app';
export { USER_RE } from '../text';
export const cleanUsername = (u: string) => u.trim().toLowerCase();
export const toEmail = (u: string) => `${cleanUsername(u)}@${DOMAIN}`;
export const usernameOf = (email?: string | null) => (email ?? '').replace(`@${DOMAIN}`, '');

const netErr = () => new ApiError(0, 'Sem internet. Conecte para entrar.', 'SEM_INTERNET');

/** true = banca ainda sem nenhuma conta (mostra "Criar cadastro") */
export async function needsSetup(): Promise<boolean> {
  try {
    const r = await sb().rpc('app_needs_setup');
    if (r.error) throw r.error;
    try { localStorage.setItem('folha.needsSetup', r.data ? '1' : '0'); } catch { /* */ }
    return !!r.data;
  } catch {
    return localStorage.getItem('folha.needsSetup') === '1';
  }
}

async function callFn(body: Record<string, unknown>, withSession: boolean) {
  let auth = SB_KEY;
  if (withSession) {
    const { data } = await sb().auth.getSession();
    if (!data.session) throw new ApiError(401, 'Entre com usuário e senha.', 'SEM_LOGIN');
    auth = data.session.access_token;
  }
  let r: Response;
  try {
    r = await fetch(`${SB_URL}/functions/v1/accounts`, { method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw netErr(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error || `Erro ${r.status}`, j.code || 'ERRO');
  return j;
}

/** Entra com usuário + senha e já abre a sessão do caixa para a pessoa (sem PIN). */
export async function signIn(username: string, password: string) {
  const u = cleanUsername(username);
  if (!u) throw new ApiError(400, 'Digite o usuário.', 'DADOS');
  let res;
  try { res = await sb().auth.signInWithPassword({ email: toEmail(u), password }); } catch { throw netErr(); }
  if (res.error) {
    if (/fetch|network/i.test(res.error.message)) throw netErr();
    throw new ApiError(401, 'Usuário ou senha incorretos.', 'LOGIN_ERRADO');
  }
  return openOwnSession();
}

export async function openOwnSession() {
  const r = await sb().rpc('self_login', { p_terminal: getTerminal() });
  if (r.error) {
    if (r.error.hint !== 'SENHA_DE_NOVO') await sb().auth.signOut();
    throw new ApiError(401, r.error.message, r.error.hint || 'SEM_LOGIN');
  }
  setToken(r.data.token);
  try { localStorage.setItem('folha.cache./api/auth/me', JSON.stringify({ user: r.data.user, terminal: getTerminal() })); } catch { /* */ }
  return r.data as { token: string; user: { id: number; name: string; role: any; username: string } };
}

/** Primeiro acesso: cria a conta (vira ADMIN) e entra. */
export async function bootstrap(f: { name: string; username: string; password: string; pin: string }) {
  await callFn({ action: 'bootstrap', ...f, username: cleanUsername(f.username) }, false);
  try { localStorage.setItem('folha.needsSetup', '0'); } catch { /* */ }
  return signIn(f.username, f.password);
}

/** Admin cria funcionário com usuário + senha (+ PIN opcional) */
export const createUser = (f: { name: string; username: string; password: string; role: string; pin?: string }) =>
  callFn({ action: 'create_user', token: getToken(), ...f, username: cleanUsername(f.username) }, true);

/** Admin define uma nova senha para alguém */
export const setPassword = (userId: number, password: string) => callFn({ action: 'set_password', token: getToken(), user_id: userId, password }, true);

/** Troca a própria senha (confere a atual antes) */
export async function changeOwnPassword(current: string, next: string) {
  const { data } = await sb().auth.getSession();
  const email = data.session?.user?.email;
  if (!email) throw new ApiError(401, 'Entre com usuário e senha.', 'SEM_LOGIN');
  const chk = await sb().auth.signInWithPassword({ email, password: current });
  if (chk.error) throw new ApiError(400, /fetch/i.test(chk.error.message) ? 'Sem internet.' : 'Senha atual incorreta.', 'SENHA_ERRADA');
  const { error } = await sb().auth.updateUser({ password: next });
  if (error) throw new ApiError(400, error.message, 'AUTH');
}
