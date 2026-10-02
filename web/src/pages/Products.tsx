import { useEffect, useMemo, useState } from 'react';
import { get, post, put } from '../api';
import { matchProduct, norm } from '../text';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { MoneyInput, QtyInput } from '../components/Inputs';
import { Category, formatBRL, formatQty, Product, UNIT_NAME, UNITS, Unit, UNIT_LABEL } from '@folha/shared';

const ICONS = '🍅 🍌 🥬 🧅 🥔 🥕 🍊 🍎 🍋 🍉 🍇 🍐 🍍 🥭 🍓 🥒 🫑 🍆 🥦 🎃 🧄 🫚 🌿 🌶️ 🥚 🫘 🧀 🥖 💧 🥤 🛍️ 🧺 🍠 🥥 🥑 🌽 🍈 🍑 🍒 🥝'.split(' ');

export function Products({ tab: tabProp }: { tab?: string }) {
  const { toast, go } = useApp();
  const [list, setList] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [q, setQ] = useState(''); const [cat, setCat] = useState<number | ''>('');
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  const tab = tabProp === 'atalhos' || tabProp === 'precos' ? tabProp : 'lista';
  const setTab = (t: string) => go(`produtos/${t}`);
  const load = () => Promise.all([get('/api/products'), get('/api/categories')]).then(([p, c]) => { setList(p); setCats(c); }).catch((e) => toast(e.message, 'erro'));
  useEffect(() => { load(); }, []); // eslint-disable-line
  const shown = useMemo(() => list.filter((p) => (!cat || p.category_id === cat) &&
    matchProduct(p, q)), [list, q, cat]);

  return (
    <div className="page">
      <div className="page-title"><h1>🥕 Produtos</h1>
        <div className="tabs"><button className={tab === 'lista' ? 'on' : ''} onClick={() => setTab('lista')}>Cadastro</button>
          <button className={tab === 'precos' ? 'on' : ''} onClick={() => setTab('precos')}>🏷 Preço do dia</button>
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
      ) : tab === 'precos' ? <PriceEditor products={list} cats={cats} onSaved={load} /> : <ShortcutEditor products={list} onSaved={load} />}
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

/** Preço do dia: a lista inteira editável; salva todas as mudanças de uma vez (com auditoria de antes/depois). */
function PriceEditor({ products, cats, onSaved }: { products: Product[]; cats: Category[]; onSaved: () => void }) {
  const { toast } = useApp();
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [q, setQ] = useState(''); const [cat, setCat] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => products.filter((p) => p.active).sort((a, b) => (a.category_id - b.category_id) || norm(a.name).localeCompare(norm(b.name))), [products]);
  const shown = active.filter((p) => (!cat || p.category_id === cat) && matchProduct(p, q));
  const changed = active.filter((p) => draft[p.id] != null && draft[p.id] !== p.price_cents);
  const priceOf = (p: Product) => draft[p.id] ?? p.price_cents;
  const bump = (pct: number) => setDraft((d) => {
    const n = { ...d };
    for (const p of shown) { const v = Math.round((priceOf(p) * (100 + pct)) / 100 / 10) * 10 - (pct ? 1 : 0); n[p.id] = Math.max(0, v); }
    return n;
  });
  const save = async () => {
    setBusy(true);
    try {
      const r = await put('/api/prices', { items: changed.map((p) => ({ id: p.id, price_cents: draft[p.id] })) });
      toast(`${r.changed} preço(s) atualizado(s). Já valem na venda.`); setDraft({}); onSaved();
    } catch (e: any) { toast(e.message, 'erro'); } finally { setBusy(false); }
  };
  const catName = (id: number) => cats.find((c) => c.id === id)?.name ?? '';
  let lastCat = -1;
  return (
    <div className="card col">
      <div className="row wrap">
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Buscar (ex.: tomate, banana)" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 200 }} value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Todas as categorias</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <div className="row" style={{ gap: 6 }}><span className="small muted">Na lista:</span>
          <button className="btn btn-sm" onClick={() => bump(-10)}>−10%</button><button className="btn btn-sm" onClick={() => bump(10)}>+10%</button></div>
      </div>
      <div className="small muted">Toque no preço e digite o novo (ex.: 799 = R$ 7,99). O que mudou fica destacado; nada muda até você salvar.</div>
      <div className="prices">
        {shown.map((p) => {
          const v = priceOf(p); const ch = v !== p.price_cents;
          const margin = v > 0 ? Math.round(((v - p.cost_cents) / v) * 100) : 0;
          const head = p.category_id !== lastCat ? (lastCat = p.category_id, <div key={`c${p.category_id}`} className="price-cat">{catName(p.category_id)}</div>) : null;
          return [head, (
            <div key={p.id} className={`price-row ${ch ? 'changed' : ''}`}>
              <span className="em">{p.icon}</span>
              <span className="grow pn"><b>{p.name}</b><small className="muted">{UNIT_NAME[p.unit as Unit] ?? p.unit} · custo {formatBRL(p.cost_cents)} · margem <span className={margin < 15 ? 'neg' : ''}>{margin}%</span></small></span>
              {ch && <span className="old num">{formatBRL(p.price_cents)}</span>}
              <MoneyInput className="price-in" value={v} onChange={(c) => setDraft((d) => ({ ...d, [p.id]: c }))} aria-label={`Preço de ${p.name}`} />
              {ch && <button className="btn btn-sm btn-ghost" title="Desfazer" onClick={() => setDraft((d) => { const n = { ...d }; delete n[p.id]; return n; })}>↺</button>}
            </div>)];
        })}
        {!shown.length && <div className="empty-mini">Nenhum produto com “{q}”.</div>}
      </div>
      <div className="save-bar">
        <span className="grow"><b>{changed.length}</b> preço(s) alterado(s)</span>
        {changed.length > 0 && <button className="btn" onClick={() => setDraft({})}>Desfazer tudo</button>}
        <button className="btn btn-primary btn-big" disabled={!changed.length || busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar preços do dia'}</button>
      </div>
    </div>
  );
}
