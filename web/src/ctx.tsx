import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Role } from '@folha/shared';
import { get, post, setToken, setOnUnauthorized, getToken, ApiError, IS_SB } from './api';
import { PinModal } from './components/PinPad';

export interface Me { id: number; name: string; role: Role }
interface Ctx {
  user: Me | null; setUser: (u: Me | null) => void;
  status: any; refreshStatus: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'erro') => void;
  /** Executa fn; se o servidor pedir gerente, pede o PIN e repete. */
  withManager: <T>(fn: (pin?: string) => Promise<T>, why?: string) => Promise<T | null>;
  logout: () => void;
  /** modo online: conta da loja (Supabase Auth) — 'loading' | 'out' | e-mail */
  store: string; storeLogout: () => Promise<void>;
  online: boolean; pending: { n: number; errors: number }; flush: () => Promise<void>;
  route: string; go: (r: string) => void;
}
const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [toastMsg, setToastMsg] = useState<{ m: string; k: 'ok' | 'erro' } | null>(null);
  const [pinAsk, setPinAsk] = useState<{ why: string; error?: string; resolve: (p: string | null) => void } | null>(null);
  const [route, setRoute] = useState(() => location.hash.replace('#/', '') || 'venda');
  const timer = useRef<number>();
  const [store, setStore] = useState<string>(IS_SB ? 'loading' : 'local');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pending, setPending] = useState({ n: 0, errors: 0 });

  // ---- modo online: sessão da conta da loja + fila offline ----
  useEffect(() => {
    if (!IS_SB) return;
    let unsub = () => {};
    (async () => {
      const { sb } = await import('./backend/client');
      const { data } = await sb().auth.getSession();
      setStore(data.session?.user?.email ?? 'out');
      const { data: sub } = sb().auth.onAuthStateChange((_e, s) => setStore(s?.user?.email ?? 'out'));
      unsub = () => sub.subscription.unsubscribe();
      const off = await import('./backend/offline');
      const upd = () => { const q = off.queue(); setPending({ n: q.length, errors: q.filter((x) => x.error).length }); };
      upd(); const u2 = off.onQueueChange(upd); const prev = unsub; unsub = () => { prev(); u2(); };
    })();
    const on = () => setOnline(true); const offf = () => setOnline(false);
    const netEv = (e: Event) => setOnline(!!(e as CustomEvent).detail && navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', offf); window.addEventListener('folha:net', netEv);
    return () => { unsub(); window.removeEventListener('online', on); window.removeEventListener('offline', offf); window.removeEventListener('folha:net', netEv); };
  }, []);
  const flush = useCallback(async () => {
    if (!IS_SB) return;
    const m = await import('./backend/supabase');
    const r = await m.flushQueue();
    if (r.sent) { setToastMsg({ m: `${r.sent} venda(s) feitas sem internet foram enviadas.`, k: 'ok' }); }
    if (r.failed) { setToastMsg({ m: `${r.failed} venda(s) offline com erro — veja a faixa no topo.`, k: 'erro' }); }
  }, []);
  useEffect(() => {
    if (!IS_SB || store === 'loading' || store === 'out') return;
    if (online) flush();
    // tenta de novo a cada 20 s (também serve para perceber que a rede voltou)
    const i = setInterval(() => { if (navigator.onLine) { flush(); if (getToken()) refreshStatus(); } }, 20000);
    return () => clearInterval(i);
  }, [online, store, flush]); // eslint-disable-line
  const storeLogout = useCallback(async () => {
    const { sb } = await import('./backend/client');
    try { await post('/api/auth/logout'); } catch { /* */ }
    setToken(null); setUser(null); setStatus(null);
    await sb().auth.signOut();
  }, []);

  useEffect(() => {
    const f = () => setRoute(location.hash.replace('#/', '') || 'venda');
    window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f);
  }, []);
  const go = (r: string) => { location.hash = '#/' + r; };

  const toast = useCallback((m: string, k: 'ok' | 'erro' = 'ok') => {
    setToastMsg({ m, k }); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastMsg(null), k === 'erro' ? 5000 : 2600);
  }, []);
  const logout = useCallback(() => { post('/api/auth/logout').catch(() => {}); setToken(null); setUser(null); setStatus(null); }, []);
  useEffect(() => { setOnUnauthorized((kind) => {
    setToken(null); setUser(null);
    if (kind === 'store' && IS_SB) import('./backend/client').then(({ sb }) => sb().auth.signOut());
  }); }, []);
  useEffect(() => {
    if (!getToken() || store === 'loading' || store === 'out') return;
    get('/api/auth/me').then((r) => setUser(r.user)).catch((e) => { if (!(e instanceof ApiError && e.code === 'SEM_INTERNET')) setToken(null); });
  }, [store]);
  const refreshStatus = useCallback(async () => { try { setStatus(await get('/api/status')); } catch { /* */ } }, []);
  useEffect(() => { if (user) { refreshStatus(); const i = setInterval(refreshStatus, 60000); return () => clearInterval(i); } }, [user, refreshStatus]);

  const askPin = (why: string, error?: string) => new Promise<string | null>((resolve) => setPinAsk({ why, error, resolve }));
  const withManager = useCallback(async <T,>(fn: (pin?: string) => Promise<T>, why = 'Autorização do gerente'): Promise<T | null> => {
    try { return await fn(undefined); } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'PRECISA_GERENTE') throw e;
      let msg = e.message; let err: string | undefined;
      for (;;) {
        const pin = await askPin(msg || why, err);
        if (!pin) return null;
        try { const r = await fn(pin); setPinAsk(null); return r; } catch (e2) {
          if (e2 instanceof ApiError && e2.code === 'PRECISA_GERENTE') { err = e2.message; continue; }
          setPinAsk(null); throw e2;
        }
      }
    }
  }, []);

  return (
    <C.Provider value={{ user, setUser, status, refreshStatus, toast, withManager, logout, route, go, store, storeLogout, online, pending, flush }}>
      {children}
      {pinAsk && <PinModal title="PIN do gerente" subtitle={pinAsk.why} error={pinAsk.error}
        onCancel={() => { pinAsk.resolve(null); setPinAsk(null); }}
        onSubmit={(p) => { pinAsk.resolve(p); }} />}
      {toastMsg && <div className={`toast ${toastMsg.k}`} role="status">{toastMsg.m}</div>}
    </C.Provider>
  );
}
