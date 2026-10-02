import { useEffect, useState } from 'react';
import { authUrl, get, post, put, getTerminal, setTerminal, fmtDateTime } from '../api';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { ROLE_LABEL, ROLES, Role, pctToText } from '@folha/shared';

export function Settings() {
  const { toast, user, refreshStatus } = useApp();
  const [s, setS] = useState<any>(null);
  const [term, setTerm] = useState(getTerminal());
  const [users, setUsers] = useState<any[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [editUser, setEditUser] = useState<any>(null);
  const [tab, setTab] = useState<'loja' | 'usuarios' | 'backup' | 'auditoria'>('loja');
  const isAdmin = user?.role === 'admin';
  useEffect(() => {
    get('/api/settings').then(setS); get('/api/users').then(setUsers).catch(() => {});
    get('/api/backup').then(setBackups).catch(() => {}); get('/api/audit?limit=150').then(setAudit).catch(() => {});
  }, []);
  const set = (k: string, v: any) => setS((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    try { setS(await put('/api/settings', s)); setTerminal(term); toast('Configurações salvas.'); refreshStatus(); }
    catch (e: any) { toast(e.message, 'erro'); }
  };
  const backup = async () => {
    try { const r = await post('/api/backup'); toast(`Backup criado: ${r.file}`); setBackups(await get('/api/backup')); }
    catch (e: any) { toast(e.message, 'erro'); }
  };
  const testPrinter = async () => { const r = await post('/api/printer/test'); toast(r.ok ? 'Impressora respondeu.' : r.error, r.ok ? 'ok' : 'erro'); };
  if (!s) return <div className="page">Carregando…</div>;
  return (
    <div className="page">
      <div className="page-title"><h1>⚙️ Configurações</h1>
        <div className="tabs">{([['loja', 'Loja e cupom'], ['usuarios', 'Usuários'], ['backup', 'Backup'], ['auditoria', 'Auditoria']] as const).map(([k, l]) =>
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      {tab === 'loja' && <>
        <div className="grid2">
          <div className="card col">
            <h3>Dados da loja (saem no cupom)</h3>
            <label className="field">Nome da banca<input className="input" value={s.name} onChange={(e) => set('name', e.target.value)} /></label>
            <label className="field">Razão social<input className="input" value={s.legal_name} onChange={(e) => set('legal_name', e.target.value)} /></label>
            <div className="grid2">
              <label className="field">CNPJ<input className="input" value={s.cnpj} onChange={(e) => set('cnpj', e.target.value)} /></label>
              <label className="field">Telefone<input className="input" value={s.phone} onChange={(e) => set('phone', e.target.value)} /></label>
            </div>
            <label className="field">Endereço<input className="input" value={s.address} onChange={(e) => set('address', e.target.value)} /></label>
            <label className="field">Mensagem do rodapé<input className="input" value={s.receipt_footer} onChange={(e) => set('receipt_footer', e.target.value)} /></label>
          </div>
          <div className="card col">
            <h3>Regras do caixa</h3>
            <label className="field">Desconto máximo sem gerente: {pctToText(s.discount_limit_pct)}
              <input type="range" min={0} max={5000} step={100} value={s.discount_limit_pct} onChange={(e) => set('discount_limit_pct', Number(e.target.value))} style={{ accentColor: 'var(--folha)', height: 40 }} /></label>
            <label className="check"><input type="checkbox" checked={s.allow_negative_stock} onChange={(e) => set('allow_negative_stock', e.target.checked)} /> Liberar estoque negativo (vender mesmo sem saldo)</label>
            <label className="field">Alerta de validade (dias antes)<input className="input" type="number" min={0} max={60} value={s.expiry_alert_days} onChange={(e) => set('expiry_alert_days', Number(e.target.value))} /></label>
            <label className="field">Nome deste terminal<input className="input" value={term} onChange={(e) => setTerm(e.target.value)} /></label>
            <h3 style={{ marginTop: 6 }}>Impressora térmica (rede, ESC/POS 80 mm)</h3>
            <div className="grid2" style={{ gridTemplateColumns: '2fr 1fr' }}>
              <label className="field">IP da impressora<input className="input" placeholder="192.168.0.50 (vazio = sem impressora)" value={s.printer_host} onChange={(e) => set('printer_host', e.target.value)} /></label>
              <label className="field">Porta<input className="input" type="number" value={s.printer_port} onChange={(e) => set('printer_port', Number(e.target.value))} /></label>
            </div>
            <button className="btn" onClick={testPrinter}>Testar impressora</button>
            <h3 style={{ marginTop: 6 }}>Etiqueta de balança (EAN começando com 2)</h3>
            <div className="grid2">
              <label className="field">Valor na etiqueta<select className="input" value={s.scale_label_mode} onChange={(e) => set('scale_label_mode', e.target.value)}>
                <option value="peso">Peso (gramas)</option><option value="preco">Preço (centavos)</option></select></label>
              <label className="field">Dígitos do código<select className="input" value={s.scale_code_digits} onChange={(e) => set('scale_code_digits', Number(e.target.value))}>
                <option value={4}>4</option><option value={5}>5</option><option value={6}>6</option></select></label>
            </div>
          </div>
        </div>
        <div className="row"><span className="spacer" /><button className="btn btn-primary btn-big" onClick={save}>Salvar configurações</button></div>
      </>}
      {tab === 'usuarios' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}><h3 className="grow" style={{ margin: 0 }}>Usuários e PINs</h3>
            {isAdmin && <button className="btn btn-primary" onClick={() => setEditUser({ name: '', role: 'operador', active: true })}>+ Novo usuário</button>}</div>
          <table className="t"><thead><tr><th>Nome</th><th>Papel</th><th>Situação</th><th /></tr></thead>
            <tbody>{users.map((u) => <tr key={u.id}><td><b>{u.name}</b></td><td>{ROLE_LABEL[u.role as Role]}</td><td>{u.active ? <span className="tag ok">Ativo</span> : <span className="tag bad">Inativo</span>}</td>
              <td className="r">{isAdmin && <button className="btn btn-sm" onClick={() => setEditUser({ ...u, active: !!u.active })}>Editar / trocar PIN</button>}</td></tr>)}</tbody></table>
          <div className="small muted" style={{ marginTop: 8 }}>Gerente autoriza cancelamento, desconto acima do limite, perda e ajuste. Só o admin cria usuários.</div>
        </div>
      )}
      {tab === 'backup' && (
        <div className="card col">
          <h3>Backup do banco (SQLite)</h3>
          <div className="muted">Faça no fim do dia e copie para um pendrive. O arquivo tem todas as vendas, estoque e fiado.</div>
          <div><button className="btn btn-primary btn-big" onClick={backup}>💾 Fazer backup agora</button></div>
          <table className="t"><thead><tr><th>Arquivo</th><th>Data</th><th className="r">Tamanho</th><th /></tr></thead>
            <tbody>{backups.map((b) => <tr key={b.file}><td>{b.file}</td><td>{new Date(b.created_at).toLocaleString('pt-BR')}</td><td className="r">{(b.size / 1024).toFixed(0)} KB</td>
              <td className="r"><a className="btn btn-sm" href={authUrl(`/api/backup/${b.file}`)}>⬇ Baixar</a></td></tr>)}</tbody></table>
        </div>
      )}
      {tab === 'auditoria' && (
        <div className="card">
          <h3>Log de auditoria (últimos 150)</h3>
          <table className="t"><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead>
            <tbody>{audit.map((a) => <tr key={a.id}><td>{fmtDateTime(a.created_at)}</td><td>{a.user_name ?? '—'}</td><td><span className="tag">{a.action}</span></td>
              <td className="small muted" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.details}</td></tr>)}</tbody></table>
        </div>
      )}
      {editUser && <UserForm u={editUser} onClose={() => setEditUser(null)} onDone={async () => { setEditUser(null); setUsers(await get('/api/users')); }} />}
    </div>
  );
}

function UserForm({ u, onClose, onDone }: { u: any; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({ ...u, pin: '' }); const [err, setErr] = useState('');
  const save = async () => {
    const body: any = { name: f.name, role: f.role, active: f.active }; if (f.pin) body.pin = f.pin;
    try { u.id ? await put(`/api/users/${u.id}`, body) : await post('/api/users', body); toast('Usuário salvo.'); onDone(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title={u.id ? `Editar ${u.name}` : 'Novo usuário'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn btn-primary" onClick={save}>Salvar</button></>}>
      <label className="field">Nome<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
      <div className="field"><span>Papel</span><div className="tabs">{ROLES.map((r) => <button key={r} className={f.role === r ? 'on' : ''} onClick={() => setF({ ...f, role: r })}>{ROLE_LABEL[r]}</button>)}</div></div>
      <label className="field">{u.id ? 'Novo PIN (deixe vazio para manter)' : 'PIN (4 dígitos)'}
        <input className="input num" inputMode="numeric" maxLength={4} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo</label>
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}
