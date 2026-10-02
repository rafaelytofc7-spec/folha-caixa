// Configura o Auth do projeto: desliga cadastro público e cria a conta da loja.
// Roda SÓ no computador de quem administra (usa SUPABASE_ACCESS_TOKEN e a chave service_role em memória).
// Uso: node supabase/setup-auth.mjs email@exemplo.com   → senha gerada vai para .store_login (chmod 600)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const REF = process.env.SUPABASE_PROJECT_REF || 'cprtigvovwbmigxbosac';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const email = process.argv[2];
if (!TOKEN || !email) { console.error('Uso: SUPABASE_ACCESS_TOKEN=... node supabase/setup-auth.mjs email'); process.exit(1); }
const api = async (p, init = {}) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const t = await r.text(); if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : null;
};
const sql = (query) => api('/database/query', { method: 'POST', body: JSON.stringify({ query }) });
const keys = await api('/api-keys?reveal=true');
const service = keys.find((k) => k.name === 'service_role')?.api_key;
if (!service) throw new Error('service_role não encontrada');
await api('/config/auth', { method: 'PATCH', body: JSON.stringify({ disable_signup: true, external_anonymous_users_enabled: false }) });
const cfg = await api('/config/auth');
console.log('disable_signup =', cfg.disable_signup);
const url = `https://${REF}.supabase.co/auth/v1`;
const H = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
const password = crypto.randomBytes(18).toString('base64url') + '#9a';
const list = await (await fetch(`${url}/admin/users?per_page=200`, { headers: H })).json();
let user = (list.users || []).find((u) => u.email === email);
if (user) {
  const r = await fetch(`${url}/admin/users/${user.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ password, email_confirm: true }) });
  if (!r.ok) throw new Error('update user ' + r.status + ' ' + (await r.text()).slice(0, 200));
} else {
  const r = await fetch(`${url}/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!r.ok) throw new Error('create user ' + r.status + ' ' + (await r.text()).slice(0, 200));
  user = await r.json();
}
await sql(`insert into store_accounts(user_id, label) values ('${user.id}', 'Conta da loja') on conflict (user_id) do nothing`);
const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.store_login');
fs.writeFileSync(file, `email=${email}\npassword=${password}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log('Conta pronta:', email, 'uid', user.id, '— senha salva em', path.resolve(file));
