// Configura o Auth do projeto: cadastro público DESLIGADO (contas só nascem pela Edge Function "accounts").
// Uso: SUPABASE_ACCESS_TOKEN=... node supabase/setup-auth.mjs
const REF = process.env.SUPABASE_PROJECT_REF || 'cprtigvovwbmigxbosac';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN.'); process.exit(1); }
const api = async (p, init = {}) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const t = await r.text(); if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : null;
};
await api('/config/auth', { method: 'PATCH', body: JSON.stringify({ disable_signup: true, external_anonymous_users_enabled: false, password_min_length: 8 }) });
const cfg = await api('/config/auth');
console.log('disable_signup =', cfg.disable_signup, '| password_min_length =', cfg.password_min_length);
