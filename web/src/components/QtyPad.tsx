// v3.3: teclado de quantidade/peso — grande no celular, rápido no PC, difícil de errar.
//  kg: 350 = 0,350 kg · 1,5 = 1,500 kg · 2 = 2 kg · +100 g/+250 g/+500 g/+1 kg · modo "valor em R$" (calcula o peso)
//  unidade: − / + e 1 · 2 · 3 · 6 · 12
import { useEffect, useMemo, useState } from 'react';
import { formatBRL, formatKg, formatQty, isGramEntry, kgEntryHint, kgForValue, lineValue, parseKgEntry, parseMoneyEntry, parseUnitEntry, Product, qtyToEntry, UNIT_LABEL } from '@folha/shared';

export interface QtyPadState { qty: number; valid: boolean }

export function QtyPad({ product, initial, onChange, onEnter, autoKeys = true }: {
  product: Pick<Product, 'unit' | 'price_cents' | 'name'> & { promo_active?: boolean; regular_price_cents?: number } | null;
  initial: number; onChange: (qty: number) => void; onEnter?: (qty: number) => void; autoKeys?: boolean;
}) {
  const kg = !product || product.unit === 'KG';
  const [mode, setMode] = useState<'peso' | 'valor'>('peso');
  const [entry, setEntry] = useState(() => (initial > 0 ? qtyToEntry(initial, kg) : ''));
  const [fresh, setFresh] = useState(initial > 0); // 1ª tecla substitui o valor que já estava
  const price = product?.price_cents ?? 0;
  const qty = useMemo(() => {
    if (!kg) return parseUnitEntry(entry);
    if (mode === 'valor') return kgForValue(parseMoneyEntry(entry), price);
    return Math.min(99999, parseKgEntry(entry));
  }, [entry, kg, mode, price]);
  useEffect(() => { onChange(qty); }, [qty]); // eslint-disable-line

  const type = (k: string) => {
    setEntry((e) => {
      const base = fresh ? '' : e;
      if (k === ',') return kg && !base.includes(',') ? (base || '0') + ',' : base;
      if (kg && mode === 'peso' && base.includes(',') && base.split(',')[1].length >= 3) return base;
      if (kg && mode === 'valor' && base.includes(',') && base.split(',')[1].length >= 2) return base;
      const n = base + k;
      return n.replace(/^0+(?=\d)/, '').slice(0, 9);
    });
    setFresh(false);
  };
  const back = () => { setFresh(false); setEntry((e) => (fresh ? '' : e.slice(0, -1))); };
  const setQty = (q: number) => { setMode('peso'); setFresh(true); setEntry(q > 0 ? qtyToEntry(q, kg) : ''); };
  const switchMode = (m: 'peso' | 'valor') => { if (m === mode) return; setMode(m); setEntry(''); setFresh(false); };

  useEffect(() => {
    if (!autoKeys) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); type(e.key); }
      else if (e.key === ',' || e.key === '.') { e.preventDefault(); type(','); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
      else if (e.key === '+' && !kg) { e.preventDefault(); setQty(qty + 1000); }
      else if (e.key === '-' && !kg) { e.preventDefault(); setQty(Math.max(1000, qty - 1000)); }
      else if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(qty); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const unitLbl = kg ? 'kg' : UNIT_LABEL[product!.unit];
  const shown = !kg ? String(qty / 1000) : mode === 'valor' ? formatBRL(parseMoneyEntry(entry)) : formatKg(qty);
  const value = lineValue(qty, price);
  return (
    <div className="qpad" data-testid="qtypad">
      {kg && product && (
        <div className="tabs qpad-mode">
          <button className={mode === 'peso' ? 'on' : ''} onClick={() => switchMode('peso')} data-testid="qpad-peso">⚖ Peso (kg)</button>
          <button className={mode === 'valor' ? 'on' : ''} onClick={() => switchMode('valor')} data-testid="qpad-valor">R$ Valor</button>
        </div>
      )}
      <div className={`qpad-display ${fresh ? 'fresh' : ''}`} data-testid="qpad-display">
        <input className="qpad-in" inputMode="decimal" aria-label={kg ? (mode === 'valor' ? 'Valor em reais' : 'Peso em kg') : 'Quantidade'}
          value={fresh || !entry ? shown : entry} onFocus={(e) => e.target.select()}
          onChange={(e) => { setFresh(false); setEntry(e.target.value.replace(/[^\d,.]/g, '').replace('.', ',')); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(qty); } }} />
        <span className="u">{kg && mode === 'valor' ? '' : kg && !fresh && isGramEntry(entry) ? 'g' : unitLbl}</span>
      </div>
      <div className="qpad-hint small" data-testid="qpad-hint">
        {!kg ? `${formatQty(qty, product!.unit)}` : mode === 'valor' ? (entry ? `${formatBRL(parseMoneyEntry(entry))} = ${formatKg(qty)} kg` : 'Valor em R$: 5,00 ou 500 = R$ 5,00') : fresh ? 'digite para trocar' : kgEntryHint(entry)}
      </div>
      {product && qty > 0 && (
        <div className="qpad-preview num" data-testid="qpad-preview">
          {kg ? `${formatKg(qty)} kg` : formatQty(qty, product.unit)} × {formatBRL(price)}/{unitLbl}{product.promo_active ? ' (PROMO)' : ''} = <b>{formatBRL(value)}</b>
        </div>
      )}
      <div className="qpad-quick">
        {kg ? <>
          {[100, 250, 500].map((g) => <button key={g} className="btn" onClick={() => setQty((mode === 'valor' ? 0 : qty) + g)}>+{g} g</button>)}
          <button className="btn" onClick={() => setQty((mode === 'valor' ? 0 : qty) + 1000)}>+1 kg</button>
        </> : <>
          <button className="btn qstep" onClick={() => setQty(Math.max(1000, qty - 1000))} aria-label="Menos um">−</button>
          {[1, 2, 3, 6, 12].map((n) => <button key={n} className={`btn ${qty === n * 1000 ? 'on' : ''}`} onClick={() => setQty(n * 1000)}>{n}</button>)}
          <button className="btn qstep" onClick={() => setQty(qty + 1000)} aria-label="Mais um">+</button>
        </>}
      </div>
      <div className="pinpad qpad-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => type(d)}>{d}</button>)}
        {kg ? <button className="alt" onClick={() => type(',')}>,</button> : <button className="alt" onClick={() => setQty(0)}>Zerar</button>}
        <button onClick={() => type('0')}>0</button>
        <button className="alt" onClick={back} aria-label="Apagar">⌫</button>
      </div>
    </div>
  );
}
