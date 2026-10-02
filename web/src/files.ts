// Arquivos gerados para baixar: cupom PDF/.bin, CSV de relatório e backup.
// Modo local: o servidor gera. Modo online: tudo é gerado aqui no navegador.
import { renderText, renderEscPos, ReceiptDoc, RLine, formatMoney, formatKg, UNIT_LABEL, LOSS_LABEL, Unit, LossReason } from '@folha/shared';
import { IS_SB, authUrl, get } from './api';

export function saveBlob(data: BlobPart | Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const base = (saleId?: number, sessionId?: number) => (saleId ? `/api/sales/${saleId}/receipt` : `/api/cash/sessions/${sessionId}/report`);
const fname = (saleId?: number, sessionId?: number) => (saleId ? `cupom-${saleId}` : `fechamento-${sessionId}`);

/** PDF 80 mm (jsPDF, fonte Courier) com o mesmo modelo de linhas do cupom */
export async function receiptPdf(doc: ReceiptDoc): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const latin = (s: string) => s.replace(/[—–]/g, '-').replace(/[^\x00-\xff]/g, (c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\xff]/g, '?'));
  const W = 226.77, fs = 7.2, lh = 9.6, m = 9;
  const rendered: Array<{ l: RLine; t: string }> = [];
  for (const l of doc.lines) for (const t of renderText({ lines: [l], title: '' })) rendered.push({ l, t });
  const H = m * 2 + lh * (rendered.length + 2);
  const pdf = new jsPDF({ unit: 'pt', format: [W, H], orientation: 'portrait' });
  pdf.setProperties({ title: doc.title, creator: 'Folha Caixa' });
  let y = m + lh;
  for (const { l, t } of rendered) {
    const bold = l.k === 'title' || ('bold' in l && !!l.bold);
    pdf.setFont('courier', bold ? 'bold' : 'normal'); pdf.setFontSize(l.k === 'title' ? fs + 2 : fs);
    const green = l.k === 'title' || l.k === 'hr' || (l.k === 'lr' && l.big);
    pdf.setTextColor(green ? '#1F7A4D' : '#1C1917');
    if (l.k === 'title' || l.k === 'center') pdf.text(latin(t.trim()), W / 2, y, { align: 'center' });
    else pdf.text(latin(t), m, y);
    y += lh;
  }
  return new Uint8Array(pdf.output('arraybuffer'));
}

export async function downloadReceiptPdf(saleId?: number, sessionId?: number) {
  if (!IS_SB) { window.open(authUrl(`${base(saleId, sessionId)}.pdf`), '_blank'); return; }
  const doc = await get<ReceiptDoc>(base(saleId, sessionId));
  saveBlob(await receiptPdf(doc), `${fname(saleId, sessionId)}.pdf`, 'application/pdf');
}
export async function downloadReceiptBin(saleId?: number, sessionId?: number) {
  if (!IS_SB) { location.href = authUrl(`${base(saleId, sessionId)}.bin`); return; }
  const doc = await get<ReceiptDoc>(base(saleId, sessionId));
  saveBlob(renderEscPos(doc, saleId ? {} : { drawer: false }), `${fname(saleId, sessionId)}.bin`, 'application/octet-stream');
}

// ---------- CSV (padrão brasileiro: ; e vírgula decimal, com BOM) ----------
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (h: string[], rows: unknown[][]) => '\ufeff' + [h, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';

export async function downloadReportCsv(section: string, from: string, to: string) {
  if (!IS_SB) { location.href = authUrl(`/api/reports/csv?section=${section}&from=${from}&to=${to}`); return; }
  const r = await get(`/api/reports?from=${from}&to=${to}`);
  const m = (c: number) => formatMoney(c ?? 0);
  const qty = (q: number, u: Unit) => (u === 'KG' ? formatKg(q) : String(q / 1000));
  let out: { f: string; csv: string };
  switch (section) {
    case 'produtos': out = { f: 'produtos', csv: toCsv(['Produto', 'Unidade', 'Quantidade', 'Total (R$)', 'Custo (R$)', 'Margem (R$)'],
      r.by_product.map((p: any) => [p.name, UNIT_LABEL[p.unit as Unit], qty(p.qty, p.unit), m(p.total_cents), m(p.cost_cents), m(p.total_cents - p.cost_cents)])) }; break;
    case 'categorias': out = { f: 'categorias', csv: toCsv(['Categoria', 'Total (R$)', 'Custo (R$)', 'Margem (R$)'],
      r.by_category.map((c: any) => [c.name, m(c.total_cents), m(c.cost_cents), m(c.total_cents - c.cost_cents)])) }; break;
    case 'pagamentos': out = { f: 'pagamentos', csv: toCsv(['Forma', 'Qtd', 'Total (R$)'], r.by_payment.map((p: any) => [p.label, p.n, m(p.total_cents)])) }; break;
    case 'operadores': out = { f: 'operadores', csv: toCsv(['Operador', 'Vendas', 'Total (R$)'], r.by_operator.map((o: any) => [o.name, o.sales_count, m(o.total_cents)])) }; break;
    case 'perdas': out = { f: 'perdas', csv: toCsv(['Data', 'Produto', 'Motivo', 'Quantidade', 'Custo (R$)', 'Usuário', 'Obs'],
      r.loss_items.map((l: any) => [l.created_at, l.name, LOSS_LABEL[l.reason as LossReason], qty(l.qty, l.unit), m(l.cost_cents), l.user_name, l.note ?? ''])) }; break;
    case 'vendas': {
      const { sb } = await import('./backend/client');
      const { localizeDates } = await import('./backend/dates');
      // em páginas: o Supabase devolve no máximo 1000 linhas por consulta (e o mês pode ter milhares de vendas)
      const listData: any[] = [];
      for (let at = 0; ; at += 1000) {
        const pg = await sb().from('v_sales_list').select('*').gte('local_date', from).lte('local_date', to).order('created_at').order('id').range(at, at + 999);
        if (pg.error) throw new Error(pg.error.message);
        listData.push(...(pg.data ?? [])); if ((pg.data ?? []).length < 1000) break;
      }
      const list = { data: listData };
      const ids = listData.map((s: any) => s.id);
      const numsData: any[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const pg = await sb().from('sales').select('id, gross_cents, item_discount_cents, total_discount_cents, cost_cents').in('id', ids.slice(i, i + 200));
        if (pg.error) throw new Error(pg.error.message);
        numsData.push(...(pg.data ?? []));
      }
      const byId = new Map(numsData.map((s: any) => [s.id, s]));
      out = { f: 'vendas', csv: toCsv(['Nº', 'Data/hora', 'Situação', 'Operador', 'Cliente', 'Bruto (R$)', 'Desconto (R$)', 'Total (R$)', 'Custo (R$)', 'Pagamento'],
        (localizeDates(list.data) as any[]).map((s) => { const x: any = byId.get(s.id) ?? {};
          return [s.number, s.created_at, s.imported ? 'IMPORTADA' : s.status, s.imported ? 'Sistema antigo' : s.user_name, s.customer_name ?? '', m(x.gross_cents), m((x.item_discount_cents ?? 0) + (x.total_discount_cents ?? 0)), m(s.total_cents), s.imported ? '' : m(x.cost_cents), s.imported ? 'nao_informado' : s.methods]; })) };
      break;
    }
    default: out = { f: 'resumo', csv: toCsv(['Dia', 'Vendas', 'Total (R$)'], r.by_day.map((d: any) => [d.day, d.sales_count, m(d.total_cents)])) };
  }
  saveBlob(out.csv, `${out.f}_${from}_${to}.csv`, 'text/csv;charset=utf-8');
}

// ---------- Backup do banco online (JSON ou CSV por tabela) ----------
export const BACKUP_TABLES = ['store_settings', 'users', 'categories', 'products', 'lots', 'stock_movements', 'losses', 'customers', 'suppliers', 'purchases',
  'cash_sessions', 'cash_session_counts', 'cash_movements', 'sales', 'sale_items', 'sale_payments', 'held_sales', 'customer_ledger',
  'fiscal_documents', 'audit_log'] as const;
async function fetchTable(t: string): Promise<any[]> {
  const { sb } = await import('./backend/client');
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb().from(t).select('*').range(from, from + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  return out;
}
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
export async function backupJson(): Promise<number> {
  const data: Record<string, any[]> = {};
  let n = 0;
  for (const t of BACKUP_TABLES) { data[t] = await fetchTable(t); n += data[t].length; }
  saveBlob(JSON.stringify({ app: 'Folha Caixa', version: 1, exported_at: new Date().toISOString(), tables: data }, null, 1), `folha-backup-${stamp()}.json`, 'application/json');
  return n;
}
export async function backupCsv(t: string) {
  const rows = await fetchTable(t);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  saveBlob(toCsv(cols, rows.map((r) => cols.map((c) => (r[c] != null && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])))), `${t}-${stamp()}.csv`, 'text/csv;charset=utf-8');
}
