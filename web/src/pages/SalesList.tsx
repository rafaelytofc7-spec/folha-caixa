import { useEffect, useState } from 'react';
import { get, post, todayISO } from '../api';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { ReceiptModal } from './ReceiptModal';
import { formatBRL, PAYMENT_LABEL, PaymentMethod } from '@folha/shared';

export function SalesList() {
  const { toast, withManager, refreshStatus } = useApp();
  const [day, setDay] = useState(todayISO());
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState<number | null>(null);
  const [cancel, setCancel] = useState<any>(null);
  const load = () => get(`/api/sales?from=${day}&to=${day}`).then(setRows).catch((e) => toast(e.message, 'erro'));
  useEffect(() => { load(); }, [day]); // eslint-disable-line
  const ok = rows.filter((r) => r.status === 'FINALIZADA');
  return (
    <div className="page">
      <div className="page-title"><h1>🧾 Vendas</h1>
        <input type="date" className="input" style={{ width: 200 }} value={day} onChange={(e) => setDay(e.target.value)} />
        <span className="spacer" />
        <span className="tag ok" style={{ fontSize: 15, padding: '8px 14px' }}>{ok.length} vendas · {formatBRL(ok.reduce((a, r) => a + r.total_cents, 0))}</span>
      </div>
      <div className="card">
        <table className="t"><thead><tr><th>Nº</th><th>Hora</th><th>Operador</th><th>Cliente</th><th>Pagamento</th><th className="r">Itens</th><th className="r">Total</th><th>Situação</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}><td><b>{s.number}</b></td><td>{s.created_at.slice(11, 16)}</td><td>{s.user_name}</td><td>{s.customer_name ?? '—'}</td>
              <td>{(s.methods ?? '').split('+').map((m: string) => PAYMENT_LABEL[m as PaymentMethod]).join(' + ')}</td><td className="r">{s.items_count}</td>
              <td className="r"><b>{formatBRL(s.total_cents)}</b></td>
              <td>{s.status === 'FINALIZADA' ? <span className="tag ok">Finalizada</span> : <span className="tag bad">Cancelada</span>}</td>
              <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                <button className="btn btn-sm" onClick={() => setView(s.id)}>Cupom</button>
                {s.status === 'FINALIZADA' && day === todayISO() && <button className="btn btn-sm btn-danger" onClick={() => setCancel(s)}>Cancelar</button>}
              </div></td></tr>))}</tbody></table>
        {!rows.length && <div className="muted" style={{ padding: 12 }}>Nenhuma venda neste dia.</div>}
      </div>
      {view && <ReceiptModal saleId={view} onClose={() => setView(null)} />}
      {cancel && <CancelModal sale={cancel} onClose={() => setCancel(null)} onConfirm={async (reason) => {
        try {
          const r = await withManager((pin) => post(`/api/sales/${cancel.id}/cancel`, { reason, manager_pin: pin }), 'Cancelamento precisa do gerente');
          if (r) { toast(`Venda nº ${r.number} cancelada. Estoque e caixa estornados.`); setCancel(null); load(); refreshStatus(); }
        } catch (e: any) { toast(e.message, 'erro'); }
      }} />}
    </div>
  );
}

function CancelModal({ sale, onClose, onConfirm }: { sale: any; onClose: () => void; onConfirm: (r: string) => void }) {
  const [r, setR] = useState('');
  return (
    <Modal title={`Cancelar venda nº ${sale.number}?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Voltar</button><button className="btn btn-danger solid" onClick={() => onConfirm(r)}>Cancelar venda</button></>}>
      <div>Total <b>{formatBRL(sale.total_cents)}</b>. O estoque volta, o dinheiro sai do caixa e o fiado é estornado. Precisa do PIN do gerente.</div>
      <label className="field">Motivo<input className="input" autoFocus value={r} onChange={(e) => setR(e.target.value)} placeholder="Ex.: freguês desistiu, passou errado" /></label>
    </Modal>
  );
}
