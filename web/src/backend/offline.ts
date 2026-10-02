// Fila offline de vendas (modo online). Só aceita vendas sem fiado e sem desconto acima do limite
// (essas precisam do banco na hora). Cada venda leva um client_uuid: reenviar nunca duplica.
export interface QueuedSale { client_uuid: string; token: string; terminal: string; body: any; created_at: string; total_cents: number; error?: string }
const KEY = 'folha.offline.sales';
type L = () => void;
const listeners = new Set<L>();
export const onQueueChange = (f: L) => { listeners.add(f); return () => { listeners.delete(f); }; };
const emit = () => listeners.forEach((f) => f());
export function queue(): QueuedSale[] { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
function save(q: QueuedSale[]) { localStorage.setItem(KEY, JSON.stringify(q)); emit(); }
export function enqueue(s: QueuedSale) { save([...queue(), s]); }
export function removeQueued(uuid: string) { save(queue().filter((s) => s.client_uuid !== uuid)); }
export function markError(uuid: string, error: string) { save(queue().map((s) => (s.client_uuid === uuid ? { ...s, error } : s))); }
export const uuid = () => (crypto as any).randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
