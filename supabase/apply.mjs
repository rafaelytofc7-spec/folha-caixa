// Aplica os arquivos SQL no projeto Supabase pela Management API.
// Uso: SUPABASE_ACCESS_TOKEN=... node supabase/apply.mjs [arquivo.sql ...]   (padrão: todos de supabase/sql em ordem)
// Extra: node supabase/apply.mjs --query "select 1"   |   node supabase/apply.mjs --reset (roda reset_seed())
import fs from 'node:fs';
import path from 'node:path';
const REF = process.env.SUPABASE_PROJECT_REF || 'cprtigvovwbmigxbosac';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error('Defina SUPABASE_ACCESS_TOKEN.'); process.exit(1); }
export async function runSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`SQL falhou (${r.status}): ${txt.slice(0, 2000)}`);
  return txt ? JSON.parse(txt) : null;
}
const args = process.argv.slice(2);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'sql');
if (args[0] === '--query') { console.log(JSON.stringify(await runSql(args[1]), null, 1)); process.exit(0); }
if (args[0] === '--reset') { console.log(JSON.stringify(await runSql('select reset_seed()'))); process.exit(0); }
const files = args.length ? args : fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f));
for (const f of files) {
  process.stdout.write(`→ ${path.basename(f)} … `);
  await runSql(fs.readFileSync(f, 'utf8'));
  console.log('ok');
}
