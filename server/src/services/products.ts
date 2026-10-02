import type { DB } from '../db';
import { bad, conflict, notFound } from '../errors';
import { audit } from '../audit';
import type { AuthUser } from '../auth';
import { getSettings } from '../settings';
import { parseScaleLabel, Unit, UNITS } from '@folha/shared';
import { applyStock } from './stock';

const SELECT = `SELECT p.*, c.name AS category_name, c.color AS category_color, c.slug AS category_slug FROM products p
  JOIN categories c ON c.id = p.category_id`;

export function mapProduct(r: any) {
  if (!r) return r;
  return { ...r, active: !!r.active, allow_negative: !!r.allow_negative };
}

export function listProducts(db: DB, opts: { q?: string; active?: boolean; category_id?: number; limit?: number } = {}) {
  const where: string[] = []; const args: any[] = [];
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.push('(p.name LIKE ? OR p.code = ? OR p.ean = ?)'); args.push(`%${q}%`, q, q);
  }
  if (opts.active !== undefined) { where.push('p.active = ?'); args.push(opts.active ? 1 : 0); }
  if (opts.category_id) { where.push('p.category_id = ?'); args.push(opts.category_id); }
  const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name LIMIT ?`;
  return (db.prepare(sql).all(...args, opts.limit ?? 500) as any[]).map(mapProduct);
}

export function getProduct(db: DB, id: number) {
  const p = db.prepare(`${SELECT} WHERE p.id = ?`).get(id);
  if (!p) throw notFound('Produto não encontrado.');
  return mapProduct(p);
}

/** Busca por código, EAN ou etiqueta de balança (EAN iniciado em 2). */
export function lookupCode(db: DB, code: string) {
  const c = code.trim();
  if (!c) return null;
  const direct = db.prepare(`${SELECT} WHERE p.code = ? OR p.ean = ?`).get(c, c);
  if (direct) return { product: mapProduct(direct), qty: null as number | null, from_label: false };
  const s = getSettings(db);
  const lbl = parseScaleLabel(c, s.scale_code_digits);
  if (lbl) {
    const p = mapProduct(db.prepare(`${SELECT} WHERE p.code = ?`).get(lbl.productCode));
    if (!p) return null;
    let qty: number;
    if (s.scale_label_mode === 'peso' || p.unit !== 'KG') qty = p.unit === 'KG' ? lbl.value : lbl.value * 1000;
    else qty = p.price_cents > 0 ? Math.round((lbl.value * 1000) / p.price_cents) : 0;
    return { product: p, qty, from_label: true };
  }
  return null;
}

export interface ProductInput {
  code: string; ean?: string | null; name: string; category_id: number; unit: Unit; price_cents: number; cost_cents: number;
  min_stock: number; active: boolean; allow_negative?: boolean; shortcut_pos?: number | null; icon?: string;
  ncm?: string | null; cfop?: string | null; cst?: string | null; initial_stock?: number;
}

export function saveProduct(db: DB, user: AuthUser, id: number | null, d: ProductInput) {
  if (!d.name?.trim()) throw bad('Nome é obrigatório.');
  if (!d.code?.trim()) throw bad('Código é obrigatório.');
  if (!UNITS.includes(d.unit)) throw bad('Unidade inválida.');
  if (d.shortcut_pos != null && (d.shortcut_pos < 1 || d.shortcut_pos > 24)) throw bad('Atalho deve ser de 1 a 24.');
  const ean = d.ean?.trim() || null;
  return db.transaction(() => {
    const dup = db.prepare('SELECT id, name FROM products WHERE (code = ? OR (ean IS NOT NULL AND ean = ?)) AND id <> ?').get(d.code.trim(), ean, id ?? 0) as any;
    if (dup) throw conflict(`Código/EAN já usado por ${dup.name}.`);
    if (d.shortcut_pos) db.prepare('UPDATE products SET shortcut_pos = NULL WHERE shortcut_pos = ? AND id <> ?').run(d.shortcut_pos, id ?? 0);
    const vals = [d.code.trim(), ean, d.name.trim(), d.category_id, d.unit, d.price_cents, d.cost_cents, d.min_stock, d.active ? 1 : 0,
      d.allow_negative ? 1 : 0, d.shortcut_pos ?? null, d.icon ?? '', d.ncm || null, d.cfop || null, d.cst || null];
    let pid: number;
    if (id) {
      getProduct(db, id);
      db.prepare(`UPDATE products SET code=?, ean=?, name=?, category_id=?, unit=?, price_cents=?, cost_cents=?, min_stock=?, active=?,
        allow_negative=?, shortcut_pos=?, icon=?, ncm=?, cfop=?, cst=?, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals, id);
      pid = id;
      audit(db, user.id, 'PRODUTO_ALTERADO', 'product', id, d);
    } else {
      pid = Number(db.prepare(`INSERT INTO products(code, ean, name, category_id, unit, price_cents, cost_cents, min_stock, active,
        allow_negative, shortcut_pos, icon, ncm, cfop, cst) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals).lastInsertRowid);
      if (d.initial_stock && d.initial_stock > 0)
        applyStock(db, { productId: pid, delta: d.initial_stock, type: 'INICIAL', userId: user.id, note: 'Estoque inicial' });
      audit(db, user.id, 'PRODUTO_CRIADO', 'product', pid, d);
    }
    return getProduct(db, pid);
  })();
}

export function shortcuts(db: DB) {
  return (db.prepare(`${SELECT} WHERE p.shortcut_pos IS NOT NULL ORDER BY p.shortcut_pos`).all() as any[]).map(mapProduct);
}

export function setShortcuts(db: DB, user: AuthUser, slots: Array<{ pos: number; product_id: number | null }>) {
  db.transaction(() => {
    for (const s of slots) {
      if (s.pos < 1 || s.pos > 24) throw bad('Posição de atalho inválida.');
      db.prepare('UPDATE products SET shortcut_pos = NULL WHERE shortcut_pos = ?').run(s.pos);
      if (s.product_id) db.prepare('UPDATE products SET shortcut_pos = ? WHERE id = ?').run(s.pos, s.product_id);
    }
    audit(db, user.id, 'ATALHOS_ALTERADOS', 'products', null, slots);
  })();
  return shortcuts(db);
}

/** Itens que mais saíram (para sugerir os 24 atalhos) */
export function topSellers(db: DB, days = 30, limit = 24) {
  return db.prepare(`SELECT p.id, p.name, p.icon, SUM(i.total_cents) AS total_cents, COUNT(*) AS n FROM sale_items i
    JOIN sales s ON s.id = i.sale_id AND s.status = 'FINALIZADA' JOIN products p ON p.id = i.product_id
    WHERE s.created_at >= datetime('now','localtime', ?) GROUP BY p.id ORDER BY n DESC, total_cents DESC LIMIT ?`).all(`-${days} days`, limit);
}

export function listCategories(db: DB) {
  return db.prepare('SELECT * FROM categories ORDER BY id').all();
}
