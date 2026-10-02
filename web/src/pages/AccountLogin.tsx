import { useEffect, useState } from 'react';
import { useApp } from '../ctx';
import { LoginSide, MobileBrand } from '../components/LoginSide';
import { InstallButton } from '../components/Install';
import { USER_RE } from '../text';

const suggestUser = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/)[0]?.replace(/[^a-z0-9._-]/g, '') ?? '';
const cleanTyping = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9._-]/g, '');

/** Modo online: entra com USUÁRIO + SENHA. Na primeira vez (banca sem nenhuma conta) mostra "Criar cadastro" → vira admin. */
export function AccountLogin() {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'login' | 'cadastro'>('login');
  useEffect(() => {
    import('../backend/accounts').then((a) => a.needsSetup()).then((v) => { setSetup(v); if (v) setMode('cadastro'); });
  }, []);
  return (
    <div className="login">
      <LoginSide />
      <div className="login-main">
        <div className="login-box">
          <MobileBrand />
          {setup === null ? <div className="muted">Carregando…</div>
            : mode === 'cadastro' && setup ? <Register onLogin={() => setMode('login')} />
            : <LoginForm setup={!!setup} onRegister={() => setMode('cadastro')} />}
          <div className="login-install"><InstallButton className="btn btn-ghost install-link" label="Instalar o app neste aparelho" /></div>
        </div>
      </div>
    </div>
  );
}

function PassInput({ value, onChange, autoComplete, id }: { value: string; onChange: (v: string) => void; autoComplete: string; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pass">
      <input id={id} className="input" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} required />
      <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Esconder senha' : 'Mostrar senha'}>{show ? '🙈' : '👁'}</button>
    </div>
  );
}

function LoginForm({ setup, onRegister }: { setup: boolean; onRegister: () => void }) {
  const { passwordLogin } = useApp();
  const [u, setU] = useState(() => localStorage.getItem('folha.lastUser') ?? '');
  const [p, setP] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await passwordLogin(u, p); localStorage.setItem('folha.lastUser', u); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <form className="col" style={{ gap: 14 }} onSubmit={submit}>
      <div>
        <div className="eyebrow">Bem-vindo de volta</div>
        <h1 className="login-h1">Entrar</h1>
        <div className="muted">Use o usuário e a senha que o administrador da banca criou para você.</div>
      </div>
      <label className="field">Usuário
        <input className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" inputMode="text"
          value={u} onChange={(e) => setU(cleanTyping(e.target.value))} placeholder="ex.: maria" autoFocus={!u} required /></label>
      <label className="field">Senha<PassInput value={p} onChange={setP} autoComplete="current-password" /></label>
      {err && <div className="err">{err}</div>}
      <button className="btn btn-primary btn-big" disabled={busy || !u || !p} type="submit">{busy ? 'Entrando…' : 'Entrar'}</button>
      {setup ? <button type="button" className="btn btn-lima" onClick={onRegister}>Primeiro acesso? Criar cadastro</button>
        : <div className="small muted center">Não tem usuário? Peça ao administrador da banca (Configurações › Usuários).</div>}
    </form>
  );
}

function Register({ onLogin }: { onLogin: () => void }) {
  const { register } = useApp();
  const [f, setF] = useState({ name: '', username: '', password: '', password2: '', pin: '' });
  const [touchedUser, setTouchedUser] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!f.name.trim()) return setErr('Digite seu nome.');
    if (!USER_RE.test(f.username)) return setErr('Usuário: de 3 a 30 letras minúsculas ou números, sem espaço (pode usar . - _).');
    if (f.password.length < 8) return setErr('A senha precisa ter pelo menos 8 caracteres.');
    if (f.password !== f.password2) return setErr('As duas senhas não são iguais.');
    if (!/^\d{4}$/.test(f.pin)) return setErr('Crie um PIN de 4 números.');
    setBusy(true);
    try { await register({ name: f.name.trim(), username: f.username, password: f.password, pin: f.pin }); localStorage.setItem('folha.lastUser', f.username); }
    catch (e: any) { setErr(e.code === 'CADASTRO_FECHADO' ? e.message : e.message); setBusy(false); }
  };
  return (
    <form className="col" style={{ gap: 12 }} onSubmit={submit}>
      <div>
        <div className="eyebrow">Primeiro acesso da banca</div>
        <h1 className="login-h1">Criar cadastro</h1>
        <div className="ok-box first-box">👑 Esta é a <b>primeira conta</b>: ela vira o <b>administrador</b> da banca. Depois o cadastro fecha e só você cria os usuários da equipe.</div>
      </div>
      <label className="field">Seu nome<input className="input" value={f.name} autoComplete="name" autoFocus
        onChange={(e) => { set('name', e.target.value); if (!touchedUser) set('username', suggestUser(e.target.value)); }} placeholder="ex.: Rafael" required /></label>
      <label className="field">Usuário (para entrar)
        <input className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" value={f.username}
          onChange={(e) => { setTouchedUser(true); set('username', cleanTyping(e.target.value)); }} placeholder="ex.: rafael" required />
        <span className="hint">Minúsculas, sem espaço e sem acento.</span></label>
      <div className="grid2 tight">
        <label className="field">Senha (mín. 8)<PassInput value={f.password} onChange={(v) => set('password', v)} autoComplete="new-password" /></label>
        <label className="field">Repita a senha<PassInput value={f.password2} onChange={(v) => set('password2', v)} autoComplete="new-password" /></label>
      </div>
      <label className="field">PIN de 4 números
        <input className="input num pin-input" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={f.pin}
          onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" required />
        <span className="hint">O PIN troca de operador no caixa num toque e autoriza cancelamento, desconto e perda.</span></label>
      {err && <div className="err">{err}</div>}
      <button className="btn btn-primary btn-big" disabled={busy} type="submit">{busy ? 'Criando…' : 'Criar cadastro e entrar'}</button>
      <button type="button" className="btn btn-ghost" onClick={onLogin}>Já tenho usuário — entrar</button>
    </form>
  );
}
