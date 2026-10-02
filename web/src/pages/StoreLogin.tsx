import { useState } from 'react';
import { Logo, Leaf } from '../components/Logo';

/** Modo online: o aparelho entra UMA vez com a conta da loja (e-mail + senha). Depois cada operador usa o PIN. */
export function StoreLogin() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const { sb } = await import('../backend/client');
      const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password: pass });
      if (error) setErr(/invalid/i.test(error.message) ? 'E-mail ou senha incorretos.' : /fetch/i.test(error.message) ? 'Sem internet. Conecte para entrar.' : error.message);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <div className="login-side">
        <Logo size={40} light />
        <div>
          <div className="slogan">O caixa da banca.</div>
          <p style={{ fontSize: 19, color: '#D5E8DB', maxWidth: 440, lineHeight: 1.4 }}>
            Mesmo caixa no celular e no computador: vendas, estoque e fiado ficam juntos na nuvem.
          </p>
        </div>
        <div className="feira" aria-hidden>🍅 🍌 🥬 🧅 🥕 🍊 🍉</div>
        <div style={{ position: 'absolute', right: -60, bottom: -40, opacity: .12 }}><Leaf size={340} color="#8FBF3F" vein="#1F7A4D" /></div>
      </div>
      <div className="login-main">
        <form className="login-box" onSubmit={submit}>
          <div className="login-logo-mobile"><Logo size={30} /></div>
          <div>
            <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 13 }}>Conectar este aparelho</div>
            <h1 style={{ fontSize: 30 }}>Conta da loja</h1>
            <div className="muted">Só na primeira vez. Depois cada pessoa entra com o PIN de 4 dígitos.</div>
          </div>
          <label className="field">E-mail<input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></label>
          <label className="field">Senha<input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required /></label>
          {err && <div className="err">{err}</div>}
          <button className="btn btn-primary btn-big" disabled={busy} type="submit">{busy ? 'Entrando…' : 'Entrar'}</button>
          <div className="small muted">Não tem cadastro público: a conta é criada pelo dono da banca.</div>
        </form>
      </div>
    </div>
  );
}
