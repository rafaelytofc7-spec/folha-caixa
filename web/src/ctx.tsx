import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Role } from '@folha/shared';
import { get, post, setToken, setOnUnauthorized, getToken, ApiError } from './api';
import { PinModal } from './components/PinPad';

export interface Me { id: number; name: string; role: Role }
interface Ctx {
  user: Me | null; setUser: (u: Me | null) => void;
  status: any; refreshStatus: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'erro') => void;
  /** Executa fn; se o servidor pedir gerente, pede o PIN e repete. */
  withManager: <T>(fn: (pin?: string) => Promise<T>, why?: string) => Promise<T | null>;
  logout: () => void;
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
  useEffect(() => { setOnUnauthorized(() => { setToken(null); setUser(null); }); }, []);
  useEffect(() => {
    if (!getToken()) return;
    get('/api/auth/me').then((r) => setUser(r.user)).catch(() => setToken(null));
  }, []);
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
    <C.Provider value={{ user, setUser, status, refreshStatus, toast, withManager, logout, route, go }}>
      {children}
      {pinAsk && <PinModal title="PIN do gerente" subtitle={pinAsk.why} error={pinAsk.error}
        onCancel={() => { pinAsk.resolve(null); setPinAsk(null); }}
        onSubmit={(p) => { pinAsk.resolve(p); }} />}
      {toastMsg && <div className={`toast ${toastMsg.k}`} role="status">{toastMsg.m}</div>}
    </C.Provider>
  );
}
