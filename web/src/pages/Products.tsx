import { useEffect, useMemo, useState } from 'react';
import { get, post, put } from '../api';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { MoneyInput, QtyInput } from '../components/Inputs';
import { Category, formatBRL, formatQty, Product, UNIT_NAME, UNITS, Unit, UNIT_LABEL } from '@folha/shared';

const ICONS = '🍅 🍌 🥬 🧅 🥔 🥕 🍊 🍎 🍋 🍉 🍇 🍐 🍍 🥭 🍓 🥒 🫑 🍆 🥦 🎃 🧄 🫚 🌿 🌶️ 🥚 🫘 🧀 🥖 💧 🥤 🛍️ 🧺 🍠 🥥 🥑 🌽 🍈 🍑 🍒 🥝'.split(' ');

export function Products() {
  const { toast } = useApp();
  const [list, setList] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [q, setQ] = useState(''); const [cat, setCat] = useState<number | ''>('');
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  const [tab, setTab] = useState<'lista' | 'atalhos'>('lista');
  const load = () => Promise.all([get('/api/products'), get('/api/categories')]).then(([p, c]) => { setList(p); setCats(c); }).catch((e) => toast(e.message, 'erro'));
  useEffect(() => { load(); }, []); // eslint-disable-line
  const shown = useMemo(() => list.filter((p) => (!cat || p.category_id === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()) || p.code === q || p.ean === q)), [list, q, cat]);

  return (
    <div className="page">
      <div className="page-title"><h1>🥕 Produtos</h1>
        <div className="tabs"><button className={tab === 'lista' ? 'on' : ''} onClick={() => setTab('lista')}>Cadastro</button>
          <button className={tab === 'atalhos' ? 'on' : ''} onClick={() => setTab('atalhos')}>Atalhos da banca (24)</button></div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setEdit({ unit: 'KG', active: true, category_id: cats[0]?.id, price_cents: 0, cost_cents: 0, min_stock: 3000, icon: '🧺' })}>+ Novo produto</button>
      </div>
      {tab === 'lista' ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="input grow" placeholder="Buscar por nome, código ou EAN" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" style={{ width: 220 }} value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Todas as categorias</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <table className="t">
            <thead><tr><th>Cód.</th><th>Produto</th><th>Categoria</th><th>Un.</th><th className="r">Preço</th><th className="r">Custo</th><th className="r">Estoque</th><th>Atalho</th><th>Situação</th></tr></thead>
            <tbody>{shown.map((p) => (
              <tr key={p.id} className="click" onClick={() => setEdit(p)}>
                <td>{p.code}</td><td><b>{p.icon} {p.name}</b>{p.ean && <div className="small muted">EAN {p.ean}</div>}</td>
                <td><span className="tag" style={{ background: `color-mix(in srgb, ${p.category_color} 22%, white)` }}>{p.category_name}</span></td>
                <td>{UNIT_LABEL[p.unit]}</td><td className="r">{formatBRL(p.price_cents)}{p.unit === 'KG' ? '/kg' : ''}</td><td className="r">{formatBRL(p.cost_cents)}</td>
                <td className={`r ${p.stock_qty <= p.min_stock ? 'neg' : ''}`}>{formatQty(p.stock_qty, p.unit)}</td>
                <td>{p.shortcut_pos ?? '—'}</td><td>{p.active ? <span className="tag ok">Ativo</span> : <span className="tag bad">Inativo</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      ) : <ShortcutEditor products={list} onSaved={load} />}
      {edit && <ProductForm initial={edit} cats={cats} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function ProductForm({ initial, cats, onClose, onSaved }: { initial: Partial<Product>; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [p, setP] = useState<any>({ ncm: '', cfop: '', cst: '', ean: '', ...initial });
  const [initialStock, setInitialStock] = useState(0);
  const [err, setErr] = useState('');
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const kg = p.unit === 'KG';
  const margin = p.price_cents ? Math.round(((p.price_cents - p.cost_cents) / p.price_cents) * 100) : 0;
  const save = async () => {
    setErr('');
    const body = { code: String(p.code ?? ''), ean: p.ean || null, name: p.name ?? '', category_id: Number(p.category_id), unit: p.unit as Unit,
      price_cents: p.price_cents, cost_cents: p.cost_cents, min_stock: p.min_stock ?? 0, active: !!p.active, allow_negative: !!p.allow_negative,
      shortcut_pos: p.shortcut_pos ? Number(p.shortcut_pos) : null, icon: p.icon ?? '', ncm: p.ncm || null, cfop: p.cfop || null, cst: p.cst || null,
      ...(p.id ? {} : { initial_stock: initialStock }) };
    try { p.id ? await put(`/api/products/${p.id}`, body) : await post('/api/products', body); toast('Produto salvo.'); onSaved(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title={p.id ? `Editar · ${p.name}` : 'Novo produto'} onClose={onClose} size="wide"
      footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn btn-primary" onClick={save}>Salvar produto</button></>}>
      <div className="grid3">
        <label className="field">Código (PLU da balança)<input className="input" value={p.code ?? ''} onChange={(e) => set('code', e.target.value)} autoFocus /></label>
        <label className="field">EAN (código de barras)<input className="input" value={p.ean ?? ''} onChange={(e) => set('ean', e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field">Categoria<select className="input" value={p.category_id ?? ''} onChange={(e) => set('category_id', Number(e.target.value))}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</select></label>
      </div>
      <div className="grid3">
        <label className="field" style={{ gridColumn: 'span 2' }}>Nome<input className="input" value={p.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">Unidade<select className="input" value={p.unit} onChange={(e) => set('unit', e.target.value)}>
          {UNITS.map((u) => <option key={u} value={u}>{UNIT_NAME[u]}</option>)}</select></label>
      </div>
      <div className="grid3">
        <label className="field">{kg ? 'Preço por kg' : `Preço por ${UNIT_LABEL[p.unit as Unit]}`}<MoneyInput value={p.price_cents ?? 0} onChange={(v) => set('price_cents', v)} /></label>
        <label className="field">Custo {kg ? 'por kg' : 'unitário'} <MoneyInput value={p.cost_cents ?? 0} onChange={(v) => set('cost_cents', v)} /></label>
        <div className="field" style={{ justifyContent: 'flex-end' }}><div className="stat" style={{ padding: '8px 12px' }}><div className="lbl">Margem estimada</div><div className="val" style={{ fontSize: 22 }}>{margin}%</div></div></div>
      </div>
      <div className="grid3">
        <label className="field">Estoque mínimo ({kg ? 'kg' : UNIT_LABEL[p.unit as Unit]})<QtyInput kg={kg} value={p.min_stock ?? 0} onChange={(v) => set('min_stock', v)} /></label>
        {!p.id ? <label className="field">Estoque inicial<QtyInput kg={kg} value={initialStock} onChange={setInitialStock} /></label>
          : <div className="field"><span>Estoque atual</span><div className="input num" style={{ display: 'flex', alignItems: 'center', background: 'var(--creme-2)' }}>{formatQty(p.stock_qty, p.unit)}</div></div>}
        <label className="field">Atalho da banca (1–24)<select className="input" value={p.shortcut_pos ?? ''} onChange={(e) => set('shortcut_pos', e.target.value ? Number(e.target.value) : null)}>
          <option value="">Sem atalho</option>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i + 1}>Posição {i + 1}</option>)}</select></label>
      </div>
      <div className="field"><span>Ícone do atalho</span>
        <div className="row wrap" style={{ gap: 4 }}>{ICONS.map((ic) => (
          <button key={ic} type="button" className="btn btn-sm" style={{ fontSize: 22, minWidth: 48, borderColor: p.icon === ic ? 'var(--folha)' : undefined, background: p.icon === ic ? 'var(--folha-clara)' : undefined }} onClick={() => set('icon', ic)}>{ic}</button>))}</div>
      </div>
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={!!p.active} onChange={(e) => set('active', e.target.checked)} /> Ativo (pode vender)</label>
        <label className="check"><input type="checkbox" checked={!!p.allow_negative} onChange={(e) => set('allow_negative', e.target.checked)} /> Pode vender sem estoque (negativo)</label>
      </div>
      <details><summary className="muted" style={{ cursor: 'pointer', fontWeight: 700, minHeight: 32 }}>Dados fiscais (só guardados, para NFC-e futura)</summary>
        <div className="grid3" style={{ marginTop: 8 }}>
          <label className="field">NCM<input className="input" value={p.ncm ?? ''} onChange={(e) => set('ncm', e.target.value)} /></label>
          <label className="field">CFOP<input className="input" value={p.cfop ?? ''} onChange={(e) => set('cfop', e.target.value)} /></label>
          <label className="field">CST / CSOSN<input className="input" value={p.cst ?? ''} onChange={(e) => set('cst', e.target.value)} /></label>
        </div></details>
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

function ShortcutEditor({ products, onSaved }: { products: Product[]; onSaved: () => void }) {
  const { toast } = useApp();
  const [slots, setSlots] = useState<(number | null)[]>(() => Array(24).fill(null));
  const [sug, setSug] = useState<any[]>([]);
  useEffect(() => {
    const s: (number | null)[] = Array(24).fill(null);
    for (const p of products) if (p.shortcut_pos) s[p.shortcut_pos - 1] = p.id;
    setSlots(s);
  }, [products]);
  useEffect(() => { get('/api/shortcuts/suggest').then(setSug).catch(() => {}); }, []);
  const byId = new Map(products.map((p) => [p.id, p]));
  const save = async () => {
    try { await put('/api/shortcuts', { slots: slots.map((id, i) => ({ pos: i + 1, product_id: id })) }); toast('Atalhos salvos.'); onSaved(); }
    catch (e: any) { toast(e.message, 'erro'); }
  };
  const applySuggest = () => {
    const s: (number | null)[] = Array(24).fill(null);
    sug.slice(0, 24).forEach((x, i) => { s[i] = x.id; });
    setSlots(s);
  };
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow muted">Escolha os 24 itens que mais saem. A cor vem da categoria.</div>
        <button className="btn" disabled={!sug.length} onClick={applySuggest}>Sugerir pelos mais vendidos (30 dias)</button>
        <button className="btn btn-primary" onClick={save}>Salvar atalhos</button>
      </div>
      <div className="tiles" style={{ gridAutoRows: '128px' }}>
        {slots.map((id, i) => {
          const p = id ? byId.get(id) : null;
          return (
            <div key={i} className={`tile ${p ? '' : 'empty'}`} style={p ? { ['--c' as any]: p.category_color } : undefined}>
              <span className="pos">{i + 1}</span>
              {p && <><span className="em">{p.icon}</span><span className="nm" style={{ fontSize: 14 }}>{p.name}</span></>}
              <select className="input" style={{ minHeight: 34, fontSize: 13, padding: '0 6px', marginTop: 4 }} value={id ?? ''}
                onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setSlots((s) => s.map((x, j) => (j === i ? v : x === v && v ? null : x))); }}>
                <option value="">— livre —</option>{products.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
