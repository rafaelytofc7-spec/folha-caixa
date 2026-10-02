-- Migração v3.1 (2026-10-02): apagar produto. Aplicada no banco online com node supabase/apply-migration.mjs.

-- Idempotente. Só mexe em: coluna products.deleted_at, view v_products, expiring_lots, top_sellers, product_save e as funções novas (06).

begin;

alter table products add column if not exists deleted_at timestamptz;

drop view if exists v_products;
create view v_products with (security_invoker = true) as
  select p.*, c.name as category_name, c.color as category_color, c.slug as category_slug
    from products p join categories c on c.id = p.category_id where p.deleted_at is null;

grant select on v_products to authenticated;
revoke all on v_products from anon;

create or replace function expiring_lots(p_days int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d int;
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  d := coalesce(p_days, (select expiry_alert_days from store_settings where id = 1), 2);
  return coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('product_name', p.name, 'unit', p.unit, 'icon', p.icon,
      'days_left', l.expiry_date - _today()) order by l.expiry_date)
    from lots l join products p on p.id = l.product_id
    where l.qty_left > 0 and l.expiry_date is not null and l.expiry_date <= _today() + d and p.deleted_at is null), '[]'::jsonb);
end $$;

create or replace function top_sellers(p_days int default 30, p_limit int default 24) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  return coalesce((select jsonb_agg(x) from (
    select p.id, p.name, p.icon, sum(i.total_cents)::int total_cents, count(*)::int n from sale_items i
      join sales s on s.id = i.sale_id and s.status = 'FINALIZADA' join products p on p.id = i.product_id
     where s.created_at >= now() - make_interval(days => p_days) and p.active and p.deleted_at is null
     group by p.id order by n desc, total_cents desc limit p_limit) x), '[]'::jsonb);
end $$;

create or replace function product_save(p_token text, p_id int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_id int; v_dup text; v_code text := trim(coalesce(p_data->>'code', '')); v_ean text := nullif(trim(coalesce(p_data->>'ean', '')), '');
  v_pos int := nullif(p_data->>'shortcut_pos', '')::int; v_init int := coalesce(nullif(p_data->>'initial_stock', '')::int, 0);
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  if trim(coalesce(p_data->>'name', '')) = '' then perform _err('Nome é obrigatório.'); end if;
  if v_code = '' then perform _err('Código é obrigatório.'); end if;
  if p_data->>'unit' not in ('KG','UN','BANDEJA','MACO','DUZIA','PCT') then perform _err('Unidade inválida.'); end if;
  if v_pos is not null and (v_pos < 1 or v_pos > 24) then perform _err('Atalho deve ser de 1 a 24.'); end if;
  if coalesce((p_data->>'price_cents')::int, -1) < 0 or coalesce((p_data->>'cost_cents')::int, -1) < 0 then perform _err('Preço/custo inválido.'); end if;
  select name into v_dup from products where (code = v_code or (v_ean is not null and ean = v_ean)) and id <> coalesce(p_id, 0) limit 1;
  if v_dup is not null then perform _err('Código/EAN já usado por ' || v_dup || '.', 'CONFLITO'); end if;
  if v_pos is not null then update products set shortcut_pos = null where shortcut_pos = v_pos and id <> coalesce(p_id, 0); end if;
  if p_id is not null then
    update products set code = v_code, ean = v_ean, name = trim(p_data->>'name'), category_id = (p_data->>'category_id')::int,
      unit = p_data->>'unit', price_cents = (p_data->>'price_cents')::int, cost_cents = (p_data->>'cost_cents')::int,
      min_stock = coalesce((p_data->>'min_stock')::int, 0), active = coalesce((p_data->>'active')::boolean, true),
      allow_negative = coalesce((p_data->>'allow_negative')::boolean, false), shortcut_pos = v_pos, icon = coalesce(p_data->>'icon', ''),
      ncm = nullif(p_data->>'ncm', ''), cfop = nullif(p_data->>'cfop', ''), cst = nullif(p_data->>'cst', ''), updated_at = now()
     where id = p_id and deleted_at is null returning id into v_id;
    if v_id is null then perform _err('Produto não encontrado.', 'NAO_ENCONTRADO'); end if;
    perform _audit(u.id, 'PRODUTO_ALTERADO', 'product', v_id, p_data);
  else
    insert into products(code, ean, name, category_id, unit, price_cents, cost_cents, min_stock, active, allow_negative, shortcut_pos, icon, ncm, cfop, cst)
    values (v_code, v_ean, trim(p_data->>'name'), (p_data->>'category_id')::int, p_data->>'unit', (p_data->>'price_cents')::int,
      (p_data->>'cost_cents')::int, coalesce((p_data->>'min_stock')::int, 0), coalesce((p_data->>'active')::boolean, true),
      coalesce((p_data->>'allow_negative')::boolean, false), v_pos, coalesce(p_data->>'icon', ''),
      nullif(p_data->>'ncm', ''), nullif(p_data->>'cfop', ''), nullif(p_data->>'cst', '')) returning id into v_id;
    if v_init > 0 then perform _apply_stock(v_id, v_init, 'INICIAL', u.id, null, null, null, null, 'Estoque inicial', false); end if;
    perform _audit(u.id, 'PRODUTO_CRIADO', 'product', v_id, p_data);
  end if;
  return (select to_jsonb(v) from v_products v where v.id = v_id);
end $$;

-- v3.1: apagar produto (só gerente/admin).
--  * sem histórico (nunca vendido, comprado/entrada, ajustado, perdido nem com lote) → apaga de vez (e o "Estoque inicial" dele);
--  * com histórico → some de todas as telas (inativo, sem atalho, deleted_at), mas vendas/relatórios continuam com o nome;
--  * nos dois casos o código (PLU) e o código de barras ficam livres: no apagado com histórico viram "101~17" (sufixo ~id).
--  * restaurar devolve código/EAN originais se ainda estiverem livres.

create or replace view v_products_deleted with (security_invoker = true) as
  select p.*, c.name as category_name, c.color as category_color, c.slug as category_slug,
         regexp_replace(p.code, '~\d+$', '') as original_code, regexp_replace(p.ean, '~\d+$', '') as original_ean
    from products p join categories c on c.id = p.category_id where p.deleted_at is not null;

create or replace function _product_usage(p_id int) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sales', (select count(*) from sale_items where product_id = p_id)::int,
    'movements', (select count(*) from stock_movements where product_id = p_id and type <> 'INICIAL')::int,
    'lots', (select count(*) from lots where product_id = p_id)::int,
    'losses', (select count(*) from losses where product_id = p_id)::int)
$$;

create or replace function product_usage(p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  r := _product_usage(p_id);
  return r || jsonb_build_object('has_history', (r->>'sales')::int + (r->>'movements')::int + (r->>'lots')::int + (r->>'losses')::int > 0);
end $$;

create or replace function product_delete(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; p products; us jsonb; hist boolean;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  select * into p from products where id = p_id and deleted_at is null for update;
  if p.id is null then perform _err('Produto não encontrado (ou já apagado).', 'NAO_ENCONTRADO'); end if;
  us := _product_usage(p_id);
  hist := (us->>'sales')::int + (us->>'movements')::int + (us->>'lots')::int + (us->>'losses')::int > 0;
  if hist then
    update products set active = false, shortcut_pos = null, deleted_at = now(), updated_at = now(),
      code = code || '~' || id, ean = case when ean is null then null else ean || '~' || id end
     where id = p_id;
  else
    delete from stock_movements where product_id = p_id and type = 'INICIAL';
    delete from products where id = p_id;
  end if;
  perform _audit(u.id, 'PRODUTO_APAGADO', 'product', p_id, jsonb_build_object('name', p.name, 'code', p.code, 'ean', p.ean,
    'modo', case when hist then 'escondido (tem histórico)' else 'apagado de vez' end, 'uso', us));
  return jsonb_build_object('id', p_id, 'name', p.name, 'mode', case when hist then 'soft' else 'hard' end, 'usage', us);
end $$;

create or replace function product_restore(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; p products; v_code text; v_ean text; warn text := null;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  select * into p from products where id = p_id and deleted_at is not null for update;
  if p.id is null then perform _err('Produto apagado não encontrado.', 'NAO_ENCONTRADO'); end if;
  v_code := regexp_replace(p.code, '~\d+$', '');
  v_ean := nullif(regexp_replace(coalesce(p.ean, ''), '~\d+$', ''), '');
  if exists (select 1 from products where code = v_code and id <> p_id) then
    warn := 'O código ' || v_code || ' já é de outro produto: este voltou com o código ' || p.code || ' (mude no cadastro).';
    v_code := p.code;
  end if;
  if v_ean is not null and exists (select 1 from products where ean = v_ean and id <> p_id) then
    warn := coalesce(warn || ' ', '') || 'O código de barras ' || v_ean || ' já é de outro produto: este voltou sem código de barras.';
    v_ean := null;
  end if;
  update products set deleted_at = null, active = true, code = v_code, ean = v_ean, updated_at = now() where id = p_id;
  perform _audit(u.id, 'PRODUTO_RESTAURADO', 'product', p_id, jsonb_build_object('name', p.name, 'code', v_code, 'ean', v_ean));
  return (select to_jsonb(v) from v_products v where v.id = p_id) || jsonb_build_object('warning', warn);
end $$;

revoke all on function _product_usage(int) from public, anon, authenticated;
revoke all on function product_usage(int), product_delete(text, int), product_restore(text, int) from public, anon;
grant execute on function product_usage(int), product_delete(text, int), product_restore(text, int) to authenticated;
revoke all on v_products_deleted from anon;
grant select on v_products_deleted to authenticated;


revoke all on function expiring_lots(int), top_sellers(int, int), product_save(text, int, jsonb) from public, anon;

grant execute on function expiring_lots(int), top_sellers(int, int), product_save(text, int, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';
