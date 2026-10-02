import { useEffect, useState } from 'react';
import { get, post, setToken } from '../api';
import { useApp } from '../ctx';
import { Logo, Leaf } from '../components/Logo';
import { PinPad } from '../components/PinPad';
import { ROLE_LABEL, Role } from '@folha/shared';

export function Login() {
  const { setUser } = useApp();
  const [users, setUsers] = useState<Array<{ id: number; name: string; role: Role }>>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [store, setStore] = useState('');
  useEffect(() => {
    get('/api/auth/users').then((u) => { setUsers(u); const op = u.find((x: any) => x.role === 'operador'); setSel((op ?? u[0])?.id ?? null); })
      .catch((e) => setErr(e.message));
    get('/api/store').then((s) => setStore(s.name)).catch(() => {});
  }, []);
  const submit = async (pin: string) => {
    if (!sel) return;
    setErr('');
    try { const r = await post('/api/auth/login', { user_id: sel, pin }); setToken(r.token); setUser(r.user); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="login">
      <div className="login-side">
        <Logo size={40} light />
        <div>
          <div className="slogan">O caixa da banca.</div>
          <p style={{ fontSize: 19, color: '#D5E8DB', maxWidth: 440, lineHeight: 1.4 }}>
            Pesa, toca no atalho, recebe. Funciona sem internet, do primeiro freguês até fechar a banca.
          </p>
        </div>
        <div className="feira" aria-hidden>🍅 🍌 🥬 🧅 🥕 🍊 🍉</div>
        <div style={{ position: 'absolute', right: -60, bottom: -40, opacity: .12 }}><Leaf size={340} color="#8FBF3F" vein="#1F7A4D" /></div>
      </div>
      <div className="login-main">
        <div className="login-box">
          <div className="no-side-only" style={{ display: 'none' }}><Logo size={32} /></div>
          <div>
            <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 13 }}>{store || 'Banca'}</div>
            <h1 style={{ fontSize: 30 }}>Quem vai pro caixa?</h1>
          </div>
          <div className="users">
            {users.map((u) => (
              <button key={u.id} className={`user-tile ${sel === u.id ? 'on' : ''}`} onClick={() => { setSel(u.id); setErr(''); }}>
                <span className="av">{u.name.slice(0, 1)}</span>{u.name}<small>{ROLE_LABEL[u.role]}</small>
              </button>
            ))}
          </div>
          <div className="muted center" style={{ fontWeight: 600 }}>Digite seu PIN de 4 dígitos</div>
          {err && <div className="err center">{err}</div>}
          <PinPad onSubmit={submit} />
        </div>
      </div>
    </div>
  );
}
