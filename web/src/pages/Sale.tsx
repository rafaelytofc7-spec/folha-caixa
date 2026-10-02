import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '../api';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { MoneyInput, QtyInput } from '../components/Inputs';
import { PaymentModal } from './PaymentModal';
import { ReceiptModal } from './ReceiptModal';
import {
  calcSale, Discount, formatBRL, formatKg, formatQty, parseWeight, pctToText, Product, UNIT_LABEL, Category,
} from '@folha/shared';

export interface Line { key: number; product: Product; qty: number; discount: Discount | null }
let keySeq = 1;
const priceLabel = (p: Product) => `${formatBRL(p.price_cents)}/${p.unit === 'KG' ? 'kg' : UNIT_LABEL[p.unit]}`;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const WEIGHT_RE = /^\d{0,3}[.,]\d{1,3}$/; // 1,250 | 01.250 | ,500
const PHONE_Q = '(max-width: 720px)';
function usePhone() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_Q).matches);
  useEffect(() => { const mq = window.matchMedia(PHONE_Q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, []);
  return m;
}

export function Sale() {
  const { status, refreshStatus, toast, user } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [totalDiscount, setTotalDiscount] = useState<Discount | null>(null);
  const [weight, setWeight] = useState(0);
  const [weightFocus, setWeightFocus] = useState(false);
  const [pending, setPending] = useState<Product | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<number | null>(null);
  const [modal, setModal] = useState<null | 'pay' | 'line' | 'disc' | 'held' | 'hold' | 'weight' | 'help' | 'clear'>(null);
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [lastSale, setLastSale] = useState<{ id: number; number: number; total: number } | null>(null);
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  const [bump, setBump] = useState(0);
  const [held, setHeld] = useState<any[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const weightRef = useRef<HTMLInputElement>(null);
  const weightFresh = useRef(true);
  const isPhone = usePhone();
  const [mtab, setMtab] = useState<'itens' | 'sacola'>('itens'); // celular: produtos ou sacola

  const settings = status?.store;
  const session = status?.session?.session;
  const expiringIds = useMemo(() => new Set<number>((status?.alerts?.expiring ?? []).map((l: any) => l.product_id)), [status]);

  const loadProducts = useCallback(async () => {
    const [p, c] = await Promise.all([get<Product[]>('/api/products?active=1'), get<Category[]>('/api/categories')]);
    setProducts(p); setCats(c);
  }, []);
  useEffect(() => { loadProducts().catch((e) => toast(e.message, 'erro')); }, [loadProducts, toast]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const slots = useMemo(() => {
    const arr: (Product | null)[] = Array(24).fill(null);
    for (const p of products) if (p.shortcut_pos) arr[p.shortcut_pos - 1] = p;
    return arr;
  }, [products]);
  const results = useMemo(() => {
    const t = norm(q.trim());
    if (!t && !cat) return null;
    return products.filter((p) => (!cat || p.category_id === cat) &&
      (!t || norm(p.name).includes(t) || p.code === q.trim() || p.ean === q.trim())).slice(0, 60);
  }, [q, cat, products]);

  const calc = useMemo(() => calcSale(lines.map((l) => ({ qty: l.qty, discount: l.discount, price_cents: l.product.price_cents })), totalDiscount), [lines, totalDiscount]);
  const catColor = (p: Product) => p.category_color ?? cats.find((c) => c.id === p.category_id)?.color ?? '#8A8178';

  // no celular não puxa o teclado a cada toque
  const focusSearch = () => { if (!isPhone) setTimeout(() => searchRef.current?.focus(), 0); };
  const focusWeight = () => setTimeout(() => { weightFresh.current = true; weightRef.current?.focus(); weightRef.current?.select(); }, 0);

  const canSell = (p: Product, addQty: number) => {
    if (!p.active) { toast(`${p.name} está inativo. Não dá para vender.`, 'erro'); return false; }
    const inCart = lines.filter((l) => l.product.id === p.id).reduce((a, l) => a + l.qty, 0);
    if (p.stock_qty - inCart - addQty < 0 && !settings?.allow_negative_stock && !p.allow_negative) {
      toast(`Sem estoque de ${p.name}: tem ${formatQty(Math.max(0, p.stock_qty - inCart), p.unit)}.`, 'erro'); return false;
    }
    return true;
  };

  /** retorno visual (e vibração no celular) quando entra item na sacola */
  const feedback = (p: Product) => {
    setFlash({ id: p.id, n: Date.now() }); setBump((b) => b + 1);
    try { if (isPhone) navigator.vibrate?.(12); } catch { /* */ }
  };
  const addProduct = (p: Product, qtyOverride?: number | null) => {
    if (!session) { toast('Abra o caixa antes de vender.', 'erro'); return; }
    if (p.unit === 'KG') {
      const g = qtyOverride ?? weight;
      if (!g || g <= 0) { setPending(p); if (isPhone) setModal('weight'); else focusWeight(); return; }
      if (!canSell(p, g)) return;
      const key = keySeq++;
      setLines((ls) => [...ls, { key, product: p, qty: g, discount: null }]);
      feedback(p);
      setSel(key); setWeight(0); setPending(null); setQ(''); focusSearch();
    } else {
      const add = qtyOverride ?? 1000;
      if (!canSell(p, add)) return;
      const ex = lines.find((l) => l.product.id === p.id && !l.discount);
      if (ex) { setLines((ls) => ls.map((l) => (l.key === ex.key ? { ...l, qty: l.qty + add } : l))); setSel(ex.key); }
      else { const key = keySeq++; setLines((ls) => [...ls, { key, product: p, qty: add, discount: null }]); setSel(key); }
      feedback(p);
      setQ(''); setPending(null); focusSearch();
    }
  };

  const confirmWeight = (g: number) => {
    setWeight(g);
    if (pending && g > 0) addProduct(pending, g);
    else if (g > 0) focusSearch();
  };

  const onSearchEnter = async () => {
    const v = q.trim();
    if (!v) { if (pending && weight > 0) addProduct(pending, weight); return; }
    if (WEIGHT_RE.test(v)) { setQ(''); confirmWeight(parseWeight(v)); return; } // balança no campo de busca
    if (/^\d{4,14}$/.test(v)) {
      try {
        const r = await get(`/api/products/lookup?code=${encodeURIComponent(v)}`);
        const p = byId.get(r.product.id) ?? r.product;
        if (!p.active) { toast(`${p.name} está inativo.`, 'erro'); setQ(''); return; }
        addProduct(p, r.qty ?? (p.unit === 'KG' ? null : undefined)); setQ(''); return;
      } catch { /* cai na busca por nome/código curto */ }
    }
    const exact = products.find((p) => p.code === v || p.ean === v);
    if (exact) { addProduct(exact); return; }
    if (results && results.length === 1) { addProduct(results[0]); return; }
    if (results && results.length === 0) toast(`Nada encontrado para “${v}”.`, 'erro');
  };

  const removeLine = (key: number) => { setLines((ls) => ls.filter((l) => l.key !== key)); setSel(null); };
  const clearSale = () => { setLines([]); setTotalDiscount(null); setSel(null); setPending(null); setWeight(0); setModal(null); focusSearch(); };

  const hold = async (label: string) => {
    await post('/api/held', { label, payload: { lines: lines.map((l) => ({ product_id: l.product.id, qty: l.qty, discount: l.discount })), totalDiscount } });
    toast('Venda pausada. Atenda o próximo.'); clearSale(); refreshStatus();
  };
  const openHeld = async () => { setHeld(await get('/api/held')); setModal('held'); };
  const resume = async (id: number) => {
    if (lines.length) { toast('Pause ou finalize a venda atual antes de retomar outra.', 'erro'); return; }
    const h = await post(`/api/held/${id}/resume`);
    const ls: Line[] = [];
    for (const it of h.payload.lines ?? []) { const p = byId.get(it.product_id); if (p) ls.push({ key: keySeq++, product: p, qty: it.qty, discount: it.discount }); }
    setLines(ls); setTotalDiscount(h.payload.totalDiscount ?? null); setModal(null); refreshStatus(); toast(`Retomada: ${h.label}`);
  };

  // ---------- atalhos de teclado ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.overlay')) return;
      const k = e.key;
      const map: Record<string, () => void> = {
        F1: () => setModal('help'),
        F2: () => setModal('weight'),
        F3: () => focusSearch(),
        F4: () => focusWeight(),
        F6: () => lines.length && setModal('hold'),
        F7: () => lines.length && setModal('disc'),
        F8: () => openHeld(),
        F9: () => lines.length && setModal('clear'),
        F10: () => lines.length && session && setModal('pay'),
        F12: () => lines.length && session && setModal('pay'),
      };
      if (map[k]) { e.preventDefault(); map[k](); return; }
      const inInput = (document.activeElement as HTMLElement)?.tagName === 'INPUT';
      if (k === 'Delete' && sel != null && !(inInput && q)) { e.preventDefault(); removeLine(sel); return; }
      if ((k === 'ArrowDown' || k === 'ArrowUp') && !q && lines.length) {
        e.preventDefault();
        const i = lines.findIndex((l) => l.key === sel);
        const ni = k === 'ArrowDown' ? Math.min(lines.length - 1, i + 1) : Math.max(0, i - 1);
        setSel(lines[ni].key); return;
      }
      if (k === 'Escape' && pending) { setPending(null); focusSearch(); return; }
      if (!inInput && k.length === 1 && !e.ctrlKey && !e.metaKey) searchRef.current?.focus(); // leitor/teclado cai na busca
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const selLine = lines.find((l) => l.key === sel) ?? null;

  return (
    <div className={`sale m-${mtab}`}>
      {/* ---------- esquerda: busca + atalhos ---------- */}
      <section className="sale-left">
        <div className="searchbar">
          <input ref={searchRef} className="input grow" autoFocus={!isPhone} placeholder={isPhone ? 'Buscar produto ou código' : 'Buscar por nome, código ou EAN  (F3)'} value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(); } if (e.key === 'Escape') setQ(''); }} />
          {(q || cat) && <button className="btn" onClick={() => { setQ(''); setCat(null); focusSearch(); }}>Atalhos</button>}
        </div>
        <div className="cats">
          <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>⭐ Atalhos</button>
          {cats.map((c) => (
            <button key={c.id} className={cat === c.id ? 'on' : ''} style={{ ['--c' as any]: c.color }} onClick={() => setCat(cat === c.id ? null : c.id)}>
              <span className="sw" />{c.name}
            </button>
          ))}
        </div>
        <div className={`tiles ${results ? 'scroll' : ''}`}>
          {(results ?? slots).map((p, i) => p ? (
            <button key={flash?.id === p.id ? `${p.id}-${flash.n}` : p.id} className={`tile ${pending?.id === p.id ? 'pending' : ''} ${flash?.id === p.id ? 'added' : ''}`} style={{ ['--c' as any]: catColor(p) }} onClick={() => addProduct(p)}>
              {!results && <span className="pos">{i + 1}</span>}
              {expiringIds.has(p.id) && <span className="tag warn" style={{ position: 'absolute', top: 8, right: 6, fontSize: 10 }}>vence</span>}
              <span className="em">{p.icon || '🧺'}</span>
              <span className="nm">{p.name}</span>
              <span className="pr">{priceLabel(p)}</span>
            </button>
          ) : (
            <div key={`e${i}`} className="tile empty"><span className="pos">{i + 1}</span>{i === slots.filter(Boolean).length ? '+ atalho em Produtos' : ''}</div>
          ))}
          {results && results.length === 0 && <div className="muted" style={{ gridColumn: '1 / -1', padding: 20 }}>Nada encontrado.</div>}
        </div>
        <button key={`mb${bump}`} className={`m-bar ${bump ? 'bump' : ''}`} onClick={() => setMtab('sacola')} aria-label="Ver sacola">
          <span className="m-bag">🧺 <b>{lines.length}</b> {lines.length === 1 ? 'item' : 'itens'}</span>
          <span className="m-tot">{formatBRL(calc.total_cents)}</span>
          <span className="m-go">Sacola ›</span>
        </button>
      </section>

      {/* ---------- direita: balança + carrinho ---------- */}
      <section className="sale-right">
        <div className="m-back"><button className="btn btn-sm" onClick={() => setMtab('itens')}>‹ Produtos</button>
          <b className="grow">Sacola · {lines.length} {lines.length === 1 ? 'item' : 'itens'}</b></div>
        <div className="scale">
          <div className={`box ${weightFocus ? 'focus' : ''}`} onClick={focusWeight}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="lbl">⚖ Balança</span>
              <span className="hint" style={weight > 0 && !weightFocus ? { color: 'var(--lima)', fontWeight: 700 } : undefined}>
                {weightFocus ? 'Enter confirma' : weight > 0 ? 'Peso pronto — toque no produto' : 'F2 digitar · F4 campo'}</span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <input ref={weightRef} aria-label="Peso em kg" inputMode="numeric" value={formatKg(weight)}
                onFocus={(e) => { setWeightFocus(true); weightFresh.current = true; e.target.select(); }} onBlur={() => setWeightFocus(false)}
                onChange={(e) => {
                  const raw = e.target.value;
                  let d = raw.replace(/\D/g, '');
                  if (weightFresh.current) { weightFresh.current = false; const typed = raw.replace(formatKg(weight), ''); if (typed && /\d/.test(typed)) d = typed.replace(/\D/g, ''); }
                  setWeight(Math.min(99999, parseInt(d || '0', 10)));
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); weightFresh.current = true; confirmWeight(weight); } if (e.key === 'Escape') { setWeight(0); setPending(null); focusSearch(); } }} />
              <span className="unit">kg</span>
            </div>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => setModal('weight')}>⌨ Digitar <span className="key">F2</span></button>
            <button className="btn btn-sm" onClick={() => { setWeight(0); setPending(null); }}>Zerar</button>
          </div>
        </div>
        {pending && (
          <div className="pending-bar">
            <span style={{ fontSize: 24 }}>{pending.icon}</span>
            <span className="grow">Pese {pending.name} ({priceLabel(pending)}) e aperte Enter</span>
            <button className="btn btn-sm" onClick={() => { setPending(null); focusSearch(); }}>Esc</button>
          </div>
        )}

        <div className="cart">
          <div className="cart-h"><span>Item · preço</span><span className="right">Peso / Qtd</span><span className="right">Total</span></div>
          {!session ? <OpenCashInline /> : lines.length === 0 ? (
            <div className="cart-empty">
              <span className="em">🧺</span>
              <b style={{ fontSize: 18, color: 'var(--carvao)' }}>Sacola vazia</b>
              <span>Ponha na balança e toque no atalho, ou passe o código no leitor.</span>
              {lastSale && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setReceiptId(lastSale.id)}>🖨 Cupom da última venda (nº {lastSale.number} · {formatBRL(lastSale.total)})</button>}
            </div>
          ) : (
            <div className="cart-list">
              {lines.map((l, i) => {
                const c = calc.lines[i];
                return (
                  <div key={l.key} className={`cart-line ${sel === l.key ? 'sel' : ''} ${i === lines.length - 1 && flash ? 'fresh' : ''}`} onClick={() => { setSel(l.key); setModal('line'); }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="n">{l.product.icon} {l.product.name}</div>
                      <div className="d">{priceLabel(l.product)}{c.discount_cents > 0 && <span className="disc"> · desc. −{formatBRL(c.discount_cents)}</span>}</div>
                    </div>
                    <div className="q">{formatQty(l.qty, l.product.unit)}</div>
                    <div className="tot">{formatBRL(c.total_cents)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="totals">
          <div className="sub">
            <div>{lines.length} {lines.length === 1 ? 'item' : 'itens'} · bruto {formatBRL(calc.gross_cents)}</div>
            <div>Desconto {calc.discount_cents ? '−' + formatBRL(calc.discount_cents) : formatBRL(0)}{totalDiscount ? ' (no total)' : ''}</div>
          </div>
          <div className="big"><div className="lbl">TOTAL</div><div className="v">{formatBRL(calc.total_cents)}</div></div>
        </div>

        <div className="actions">
          <button className="btn" disabled={!lines.length} onClick={() => setModal('hold')}>Pausar<span className="key">F6</span></button>
          <button className="btn" onClick={openHeld}>Retomar{status?.held_count ? ` (${status.held_count})` : ''}<span className="key">F8</span></button>
          <button className="btn" disabled={!lines.length} onClick={() => setModal('disc')}>Desconto<span className="key">F7</span></button>
          <button className="btn btn-danger" disabled={!lines.length} onClick={() => setModal('clear')}>Limpar<span className="key">F9</span></button>
          <button className="btn btn-primary pay" disabled={!lines.length || !session} onClick={() => setModal('pay')}>Receber <span className="key">F10</span></button>
        </div>
      </section>

      {/* ---------- modais ---------- */}
      {modal === 'weight' && <WeightModal product={pending} initial={weight} onClose={() => { setModal(null); focusSearch(); }}
        onConfirm={(g) => { setModal(null); confirmWeight(g); }} />}
      {modal === 'line' && selLine && <LineModal line={selLine} onClose={() => { setModal(null); focusSearch(); }}
        onRemove={() => { removeLine(selLine.key); setModal(null); focusSearch(); }}
        onSave={(qty, discount) => {
          if (qty > selLine.qty && !canSell(selLine.product, qty - selLine.qty)) return;
          setLines((ls) => ls.map((l) => (l.key === selLine.key ? { ...l, qty, discount } : l))); setModal(null); focusSearch();
        }} limit={settings?.discount_limit_pct ?? 1000} />}
      {modal === 'disc' && <DiscountModal base={calc.subtotal_cents} initial={totalDiscount} limit={settings?.discount_limit_pct ?? 1000}
        onClose={() => setModal(null)} onSave={(d) => { setTotalDiscount(d); setModal(null); focusSearch(); }} />}
      {modal === 'hold' && <HoldModal onClose={() => setModal(null)} onSave={(l) => hold(l).catch((e) => toast(e.message, 'erro'))} />}
      {modal === 'held' && (
        <Modal title="Vendas pausadas" onClose={() => setModal(null)}>
          {held.length === 0 && <div className="muted">Nenhuma venda pausada neste caixa.</div>}
          {held.map((h) => (
            <div key={h.id} className="row card" style={{ padding: 12 }}>
              <div className="grow"><b>{h.label}</b><div className="small muted">{h.payload.lines?.length ?? 0} {(h.payload.lines?.length ?? 0) === 1 ? 'item' : 'itens'} · {h.user_name} · {h.created_at.slice(11, 16)}</div></div>
              <button className="btn btn-primary" onClick={() => resume(h.id).catch((e) => toast(e.message, 'erro'))}>Retomar</button>
            </div>
          ))}
        </Modal>
      )}
      {modal === 'clear' && (
        <Modal title="Limpar a venda?" onClose={() => setModal(null)}
          footer={<><button className="btn" onClick={() => setModal(null)}>Voltar</button><button className="btn btn-danger solid" autoFocus onClick={clearSale}>Limpar sacola</button></>}>
          <div>Os {lines.length} itens saem da tela. Nada foi vendido ainda, o estoque não muda.</div>
        </Modal>
      )}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'pay' && <PaymentModal lines={lines} totalDiscount={totalDiscount} calc={calc} onClose={() => { setModal(null); focusSearch(); }}
        onDone={(sale) => {
          setModal(null); clearSale(); setMtab('itens'); if (sale.id) { setReceiptId(sale.id); setLastSale({ id: sale.id, number: sale.number, total: sale.total_cents }); } refreshStatus(); loadProducts().catch(() => {});
        }} />}
      {receiptId && <ReceiptModal saleId={receiptId} onClose={() => { setReceiptId(null); focusSearch(); }} />}
      <span hidden>{user?.id}</span>
    </div>
  );
}

function OpenCashInline() {
  const { refreshStatus, toast, go } = useApp();
  const [v, setV] = useState(10000);
  const open = async () => {
    try { await post('/api/cash/open', { opening_float_cents: v }); toast('Caixa aberto. Boa venda!'); refreshStatus(); }
    catch (e: any) { toast(e.message, 'erro'); }
  };
  return (
    <div className="cart-empty" style={{ gap: 12 }}>
      <span className="em">🔒</span>
      <b style={{ fontSize: 20, color: 'var(--carvao)' }}>Caixa fechado</b>
      <span>Conte o fundo de troco e abra o caixa para começar.</span>
      <div className="row" style={{ width: 'min(380px, 100%)' }}>
        <MoneyInput value={v} onChange={setV} onKeyDown={(e) => e.key === 'Enter' && open()} />
        <button className="btn btn-primary" onClick={open}>Abrir caixa</button>
      </div>
      <button className="btn btn-ghost" onClick={() => go('caixa')}>Ir para o Caixa</button>
    </div>
  );
}

function WeightModal({ product, initial, onConfirm, onClose }: { product: Product | null; initial: number; onConfirm: (g: number) => void; onClose: () => void }) {
  const [g, setG] = useState(initial);
  const press = (d: string) => setG((x) => Math.min(99999, parseInt(String(x) + d, 10)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); setG((x) => Math.floor(x / 10)); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(g); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });
  return (
    <Modal title={`⚖ Peso manual${product ? ' — ' + product.name : ''}`} onClose={onClose} size="sm"
      footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn btn-primary" onClick={() => onConfirm(g)}>Confirmar (Enter)</button></>}>
      <div className="scale" style={{ justifyContent: 'flex-end' }}>
        <div className="box focus"><div className="row"><input readOnly value={formatKg(g)} /><span className="unit">kg</span></div></div>
      </div>
      {product && g > 0 && <div className="ok-box num">{formatKg(g)} kg × {formatBRL(product.price_cents)}/kg = <b>{formatBRL(Math.round(product.price_cents * g / 1000))}</b></div>}
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
        <button className="alt" onClick={() => setG(0)}>Zerar</button>
        <button onClick={() => press('0')}>0</button>
        <button className="alt" onClick={() => setG((x) => Math.floor(x / 10))}>⌫</button>
      </div>
      <div className="small muted center">Digite em gramas: 1 2 5 0 = 1,250 kg</div>
    </Modal>
  );
}

function DiscountEditor({ base, value, onChange, limit }: { base: number; value: Discount | null; onChange: (d: Discount | null) => void; limit: number }) {
  const type = value?.type ?? 'pct';
  const v = value?.value ?? 0;
  const amount = type === 'pct' ? Math.round(base * v / 10000) : Math.min(base, v);
  const pct = base ? Math.round(amount * 10000 / base) : 0;
  return (
    <div className="col">
      <div className="tabs">
        <button className={type === 'pct' ? 'on' : ''} onClick={() => onChange({ type: 'pct', value: 0 })}>% Porcentagem</button>
        <button className={type === 'valor' ? 'on' : ''} onClick={() => onChange({ type: 'valor', value: 0 })}>R$ Valor</button>
      </div>
      {type === 'pct'
        ? <input className="input big num" inputMode="numeric" value={pctToText(v)} onFocus={(e) => e.target.select()}
            onChange={(e) => onChange({ type: 'pct', value: Math.min(10000, parseInt(e.target.value.replace(/\D/g, '') || '0', 10)) })} />
        : <MoneyInput big value={v} onChange={(c) => onChange({ type: 'valor', value: c })} />}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Desconto: <b className="num" style={{ color: 'var(--tomate-2)' }}>−{formatBRL(amount)}</b> ({pctToText(pct)})</span>
        <span className="muted">Fica: <b className="num">{formatBRL(base - amount)}</b></span>
      </div>
      {pct > limit && <div className="ok-box" style={{ background: 'var(--ambar-clara)', color: '#7A4E0E' }}>Acima de {pctToText(limit)}: o gerente vai autorizar com PIN ao receber.</div>}
    </div>
  );
}

function LineModal({ line, onSave, onRemove, onClose, limit }: { line: Line; onSave: (q: number, d: Discount | null) => void; onRemove: () => void; onClose: () => void; limit: number }) {
  const [qty, setQty] = useState(line.qty);
  const [disc, setDisc] = useState<Discount | null>(line.discount);
  const kg = line.product.unit === 'KG';
  const gross = Math.round(line.product.price_cents * qty / 1000);
  return (
    <Modal title={`${line.product.icon} ${line.product.name}`} onClose={onClose} size="mid"
      footer={<><button className="btn btn-danger" onClick={onRemove}>Tirar da sacola</button><span className="spacer" />
        <button className="btn" onClick={onClose}>Voltar</button>
        <button className="btn btn-primary" disabled={qty <= 0} onClick={() => onSave(qty, disc && disc.value > 0 ? disc : null)}>Salvar</button></>}>
      <div className="grid2">
        <div className="col">
          <label className="field">{kg ? 'Peso (kg)' : `Quantidade (${UNIT_LABEL[line.product.unit]})`}
            <QtyInput big kg={kg} value={qty} onChange={setQty} autoFocus /></label>
          {!kg && <div className="row">
            <button className="btn grow" onClick={() => setQty((x) => Math.max(1000, x - 1000))}>− 1</button>
            <button className="btn grow" onClick={() => setQty((x) => x + 1000)}>+ 1</button></div>}
          <div className="muted num">{formatQty(qty, line.product.unit)} × {priceLabel(line.product)} = <b>{formatBRL(gross)}</b></div>
        </div>
        <div className="col"><b>Desconto no item</b><DiscountEditor base={gross} value={disc} onChange={setDisc} limit={limit} /></div>
      </div>
    </Modal>
  );
}

function DiscountModal({ base, initial, onSave, onClose, limit }: { base: number; initial: Discount | null; onSave: (d: Discount | null) => void; onClose: () => void; limit: number }) {
  const [d, setD] = useState<Discount | null>(initial);
  return (
    <Modal title="Desconto no total" onClose={onClose}
      footer={<><button className="btn" onClick={() => onSave(null)}>Sem desconto</button><span className="spacer" />
        <button className="btn btn-primary" onClick={() => onSave(d && d.value > 0 ? d : null)}>Aplicar</button></>}>
      <div className="muted">Subtotal da sacola: <b className="num">{formatBRL(base)}</b></div>
      <DiscountEditor base={base} value={d} onChange={setD} limit={limit} />
    </Modal>
  );
}

function HoldModal({ onSave, onClose }: { onSave: (label: string) => void; onClose: () => void }) {
  const [l, setL] = useState('');
  const now = new Date().toTimeString().slice(0, 5);
  return (
    <Modal title="Pausar venda" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn btn-primary" onClick={() => onSave(l || `Freguês das ${now}`)}>Pausar</button></>}>
      <label className="field">Nome para lembrar (opcional)
        <input className="input" autoFocus placeholder={`Freguês das ${now}`} value={l} onChange={(e) => setL(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSave(l || `Freguês das ${now}`)} /></label>
      <div className="small muted">A sacola fica guardada neste caixa. Retome com F8.</div>
    </Modal>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['F2', 'Digitar o peso (teclado numérico)'], ['F4', 'Ir para o campo da balança'], ['F3', 'Buscar produto / leitor'],
    ['Enter', 'Confirma peso, código ou busca'], ['F6', 'Pausar venda'], ['F8', 'Retomar venda pausada'], ['F7', 'Desconto no total'],
    ['F9', 'Limpar sacola'], ['F10 / F12', 'Receber (pagamento)'], ['↑ ↓', 'Escolher item da sacola'], ['Delete', 'Tirar item escolhido'], ['Esc', 'Fechar janela / cancelar pesagem'],
  ];
  return (
    <Modal title="Atalhos do teclado" onClose={onClose}>
      <table className="t"><tbody>{keys.map(([k, d]) => <tr key={k}><td style={{ width: 110 }}><span className="tag">{k}</span></td><td>{d}</td></tr>)}</tbody></table>
      <div className="small muted">Balança e leitor funcionam como teclado: o peso (ex.: 1,250) ou o código chega na busca e o Enter confirma. Etiqueta de balança (EAN que começa com 2) já traz o peso.</div>
    </Modal>
  );
}
