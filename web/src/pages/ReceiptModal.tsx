import { useEffect, useState } from 'react';
import { authUrl, get, post } from '../api';
import { useApp } from '../ctx';
import { Modal } from '../components/Modal';
import { Receipt, RLine } from '../components/Receipt';
import { formatBRL } from '@folha/shared';

/** Cupom de venda (saleId) ou relatório de caixa (sessionId) */
export function ReceiptModal({ saleId, sessionId, onClose, title }: { saleId?: number; sessionId?: number; onClose: () => void; title?: string }) {
  const { toast } = useApp();
  const [lines, setLines] = useState<RLine[] | null>(null);
  const [sale, setSale] = useState<any>(null);
  const base = saleId ? `/api/sales/${saleId}/receipt` : `/api/cash/sessions/${sessionId}/report`;
  useEffect(() => {
    get(base).then((d) => setLines(d.lines)).catch((e) => toast(e.message, 'erro'));
    if (saleId) get(`/api/sales/${saleId}`).then(setSale).catch(() => {});
  }, [base, saleId, toast]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' && saleId) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });
  const printer = async () => {
    const r = await post(saleId ? `/api/sales/${saleId}/print` : `/api/cash/sessions/${sessionId}/print`).catch((e) => ({ ok: false, error: e.message }));
    toast(r.ok ? 'Enviado para a impressora.' : r.error, r.ok ? 'ok' : 'erro');
  };
  return (
    <Modal title={title ?? (sale ? `Venda nº ${sale.number}` : 'Cupom')} onClose={onClose} size="mid"
      footer={<>
        <button className="btn" onClick={() => window.print()}>🖨 Imprimir (80 mm)</button>
        <button className="btn" onClick={printer}>Térmica ESC/POS</button>
        <a className="btn" href={authUrl(`${base}.pdf`)} target="_blank" rel="noreferrer">PDF</a>
        <a className="btn" href={authUrl(`${base}.bin`)} download>.bin</a>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={onClose}>{saleId ? 'Próximo freguês (Enter)' : 'Fechar'}</button>
      </>}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="print-area grow">{lines ? <Receipt lines={lines} /> : <div className="muted">Carregando…</div>}</div>
        {sale && (
          <div className="col no-print" style={{ width: 230 }}>
            <div className="stat verde"><div className="lbl">Total</div><div className="val">{formatBRL(sale.total_cents)}</div></div>
            {sale.change_cents > 0 && <div className="stat" style={{ background: 'var(--lima)' }}><div className="lbl" style={{ color: 'var(--folha-3)' }}>Troco</div><div className="val">{formatBRL(sale.change_cents)}</div></div>}
            <div className="small muted">Simulação fiscal: {sale.fiscal?.status ?? '—'} (sem SEFAZ)</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
