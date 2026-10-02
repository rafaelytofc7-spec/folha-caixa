import { useMemo, useState } from 'react';
import { Product, formatQty } from '@folha/shared';

export function ProductPicker({ products, value, onChange }: { products: Product[]; value: number | null; onChange: (id: number | null) => void }) {
  const [f, setF] = useState('');
  const list = useMemo(() => products.filter((p) => !f || p.name.toLowerCase().includes(f.toLowerCase()) || p.code === f || p.ean === f), [products, f]);
  return (
    <div className="row">
      <input className="input" style={{ width: 170 }} placeholder="Filtrar…" value={f} onChange={(e) => { setF(e.target.value); }} />
      <select className="input grow" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">— escolha o produto —</option>
        {list.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name} ({p.code}) · estoque {formatQty(p.stock_qty, p.unit)}{p.active ? '' : ' · INATIVO'}</option>)}
      </select>
    </div>
  );
}
