-- Migração v3.2 (2026-10-02): promoções + livro caixa (calendário). Idempotente.

begin;

-- v3.2: promoções (preço promocional com início e fim; encerrar antes = ended_at)
create table if not exists promotions (
  id serial primary key,
  product_id int not null references products(id) on delete cascade,
  promo_price_cents int not null check (promo_price_cents > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  ended_at timestamptz,
  note text,
  created_by int references users(id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists idx_promotions_product on promotions(product_id, ends_at);
alter table promotions enable row level security;
revoke insert, update, delete, truncate on promotions from anon, authenticated;
revoke all on promotions from anon;
drop policy if exists leitura_loja on promotions;
create policy leitura_loja on promotions for select to authenticated using (is_store_account());
-- item vendido em promoção: guarda a promoção usada e o preço normal da hora
alter table sale_items add column if not exists promotion_id int references promotions(id);
alter table sale_items add column if not exists regular_price_cents int;

drop view if exists v_products;
-- v3.2: promo_* = promoção vigente ou a próxima agendada (o app confere início/fim pelo relógio, até sem internet)
create view v_products with (security_invoker = true) as
  select p.*, c.name as category_name, c.color as category_color, c.slug as category_slug,
         pr.id as promo_id, pr.promo_price_cents, pr.starts_at as promo_starts_at, pr.ends_until as promo_ends_at
    from products p join categories c on c.id = p.category_id
    left join lateral (select x.id, x.promo_price_cents, x.starts_at, least(x.ends_at, coalesce(x.ended_at, x.ends_at)) as ends_until
                         from promotions x where x.product_id = p.id and least(x.ends_at, coalesce(x.ended_at, x.ends_at)) > now()
                        order by x.starts_at limit 1) pr on true
   where p.deleted_at is null;

grant select on v_products to authenticated;
revoke all on v_products from anon;

create or replace function sale_create(p_token text, p_terminal text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u users; st store_settings; sess cash_sessions; p products; it jsonb; pay jsonb; ln jsonb; v_pr promotions; v_price int; v_at timestamptz;
  v_items jsonb := coalesce(p_data->'items', '[]'::jsonb);
  v_pays jsonb := coalesce(p_data->'payments', '[]'::jsonb);
  v_lines jsonb := '[]'::jsonb;
  v_qty int; v_lg int; v_ld int; v_gross int := 0; v_item_disc int := 0; v_sub int; v_tdisc int; v_total int; v_disc int; v_pct int;
  v_paid int := 0; v_noncash int := 0; v_change int; v_fiado int := 0; v_cost int := 0; v_amt int; v_net int; v_change_left int;
  v_number int; v_sale int; v_disc_by int; v_existing int; v_key text;
  v_customer int := nullif(p_data->>'customer_id', '')::int;
  v_uuid uuid := nullif(p_data->>'client_uuid', '')::uuid;
  v_offline boolean := coalesce((p_data->>'offline')::boolean, false);
begin
  u := _op(p_token);
  if v_uuid is not null then
    select id into v_existing from sales where client_uuid = v_uuid;
    if v_existing is not null then return sale_get(v_existing); end if; -- reenvio da fila offline: idempotente
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then perform _err('Carrinho vazio.'); end if;
  if jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) = 0 then perform _err('Informe o pagamento.'); end if;
  select * into st from store_settings where id = 1;
  -- hora da venda para a promoção: venda offline usa a hora em que aconteceu (até 7 dias atrás)
  v_at := now();
  if v_offline and nullif(p_data->>'sold_at', '') is not null then
    begin v_at := greatest(least((p_data->>'sold_at')::timestamptz, now()), now() - interval '7 days'); exception when others then v_at := now(); end;
  end if;

  for it in select * from jsonb_array_elements(v_items) loop
    select * into p from products where id = (it->>'product_id')::int;
    if p.id is null then perform _err('Produto ' || coalesce(it->>'product_id', '?') || ' não encontrado.', 'NAO_ENCONTRADO'); end if;
    if not p.active then perform _err(p.name || ' está inativo e não pode ser vendido.', 'PRODUTO_INATIVO'); end if;
    v_qty := (it->>'qty')::int;
    if v_qty is null or v_qty <= 0 then perform _err('Quantidade inválida para ' || p.name || '.'); end if;
    if p.unit <> 'KG' and v_qty % 1000 <> 0 then perform _err(p.name || ' é vendido por unidade inteira.'); end if;
    -- promoção: a que o caixa usou (com folga de 2 h depois do fim, carrinho montado antes de acabar) ou a vigente agora
    v_pr := null;
    if nullif(it->>'promotion_id', '') is not null then
      select * into v_pr from promotions x where x.id = (it->>'promotion_id')::int and x.product_id = p.id
         and x.starts_at - interval '15 minutes' <= v_at and v_at < least(x.ends_at, coalesce(x.ended_at, x.ends_at)) + interval '2 hours';
    end if;
    if v_pr.id is null then
      select * into v_pr from promotions x where x.product_id = p.id and x.starts_at <= v_at
         and v_at < least(x.ends_at, coalesce(x.ended_at, x.ends_at)) order by x.starts_at desc limit 1;
    end if;
    v_price := case when v_pr.id is not null and v_pr.promo_price_cents < p.price_cents then v_pr.promo_price_cents else p.price_cents end;
    if v_price = p.price_cents then v_pr := null; end if;
    v_lg := round(v_price::numeric * v_qty / 1000.0)::int;
    v_ld := _disc(v_lg, it->'discount');
    v_gross := v_gross + v_lg; v_item_disc := v_item_disc + v_ld;
    v_cost := v_cost + round(p.cost_cents::numeric * v_qty / 1000.0)::int;
    v_lines := v_lines || jsonb_build_object('product_id', p.id, 'name', p.name, 'unit', p.unit, 'qty', v_qty,
      'price', v_price, 'regular', p.price_cents, 'promo', v_pr.id, 'cost', p.cost_cents, 'gross', v_lg, 'disc', v_ld);
  end loop;
  v_sub := v_gross - v_item_disc;
  v_tdisc := _disc(v_sub, p_data->'total_discount');
  v_total := v_sub - v_tdisc;
  v_disc := v_item_disc + v_tdisc;
  v_pct := case when v_gross > 0 then round(v_disc * 10000.0 / v_gross)::int else 0 end;
  if v_total <= 0 then perform _err('Total da venda precisa ser maior que zero.'); end if;
  if v_disc > 0 and v_pct > st.discount_limit_pct then
    v_disc_by := _authorize_manager(u, p_data->>'manager_pin',
      'Desconto de ' || _pct(v_pct) || ' acima do limite de ' || _pct(st.discount_limit_pct));
  end if;

  for pay in select * from jsonb_array_elements(v_pays) loop
    v_amt := (pay->>'amount_cents')::int;
    if pay->>'method' not in ('dinheiro','pix','debito','credito','voucher','fiado') then perform _err('Forma de pagamento inválida.', 'PAGAMENTO'); end if;
    if v_amt is null or v_amt <= 0 then perform _err('Valor de pagamento inválido.', 'PAGAMENTO'); end if;
    v_paid := v_paid + v_amt;
    if pay->>'method' <> 'dinheiro' then v_noncash := v_noncash + v_amt; end if;
    if pay->>'method' = 'fiado' then v_fiado := v_fiado + v_amt; end if;
  end loop;
  if v_paid < v_total then perform _err('Pagamento menor que o total.', 'PAGAMENTO'); end if;
  if v_noncash > v_total then perform _err('Troco só em dinheiro: PIX/cartão/voucher/fiado não podem passar do total.', 'PAGAMENTO'); end if;
  v_change := v_paid - v_total;
  if v_fiado > 0 and v_customer is null then perform _err('Fiado precisa de cliente.', 'FIADO_SEM_CLIENTE'); end if;

  sess := _require_session(p_terminal);
  update store_settings set last_sale_number = last_sale_number + 1 where id = 1 returning last_sale_number into v_number;

  insert into sales(number, client_uuid, offline, session_id, terminal, user_id, customer_id, gross_cents, item_discount_cents,
      total_discount_cents, total_cents, paid_cents, change_cents, cost_cents, discount_authorized_by)
  values (v_number, v_uuid, v_offline, sess.id, p_terminal, u.id, v_customer, v_gross, v_item_disc, v_tdisc, v_total, v_paid,
      v_change, v_cost, v_disc_by)
  returning id into v_sale;

  for ln in select * from jsonb_array_elements(v_lines) loop
    insert into sale_items(sale_id, product_id, name, unit, qty, unit_price_cents, gross_cents, discount_cents, total_cents, unit_cost_cents,
        promotion_id, regular_price_cents)
    values (v_sale, (ln->>'product_id')::int, ln->>'name', ln->>'unit', (ln->>'qty')::int, (ln->>'price')::int, (ln->>'gross')::int,
      (ln->>'disc')::int, (ln->>'gross')::int - (ln->>'disc')::int, (ln->>'cost')::int,
      nullif(ln->>'promo', '')::int, (ln->>'regular')::int);
    -- venda que já aconteceu offline não é barrada por estoque (fica registrada na auditoria)
    perform _apply_stock((ln->>'product_id')::int, -(ln->>'qty')::int, 'VENDA', u.id, null, 'venda', v_sale, null,
      'Venda nº ' || v_number, not v_offline);
  end loop;

  v_change_left := v_change;
  for pay in select * from jsonb_array_elements(v_pays) loop
    v_amt := (pay->>'amount_cents')::int; v_net := v_amt;
    if pay->>'method' = 'dinheiro' and v_change_left > 0 then
      v_net := v_amt - least(v_change_left, v_amt); v_change_left := v_change_left - least(v_change_left, v_amt);
    end if;
    insert into sale_payments(sale_id, method, amount_cents, net_cents) values (v_sale, pay->>'method', v_amt, v_net);
    if v_net <> 0 then perform _cash_move(sess.id, 'VENDA', pay->>'method', v_net, u.id, 'venda', v_sale, 'Venda nº ' || v_number); end if;
  end loop;
  if v_fiado > 0 then
    perform _ledger(v_customer, 'COMPRA', v_fiado, u.id, v_sale, sess.id, 'fiado', 'Venda nº ' || v_number, true);
  end if;
  -- FiscalProvider simulado (NFC-e futura): nada vai para a SEFAZ
  insert into fiscal_documents(sale_id, provider, status, access_key, payload)
  values (v_sale, 'mock', 'SIMULADO', left('35' || to_char(now(), 'YYMMDDHH24MISS') || lpad(v_number::text, 9, '0') || repeat('0', 44), 44),
    jsonb_build_object('message', 'Simulação — sem envio à SEFAZ. NÃO É DOCUMENTO FISCAL.'));
  perform _audit(u.id, case when v_offline then 'VENDA_OFFLINE' else 'VENDA' end, 'sale', v_sale, jsonb_build_object(
    'number', v_number, 'total', v_total, 'payments', v_pays, 'discount', v_disc, 'discount_authorized_by', v_disc_by, 'terminal', p_terminal));
  return sale_get(v_sale);
end $$;

create or replace function report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sum record; v_canc record; v_loss int; v_promo record;
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  select count(*)::int items, count(distinct i.sale_id)::int sales, coalesce(sum(i.total_cents),0)::int total,
         coalesce(sum(greatest(0, round((coalesce(i.regular_price_cents, i.unit_price_cents) - i.unit_price_cents)::numeric * i.qty / 1000.0))),0)::int savings
    into v_promo from sale_items i join sales s on s.id = i.sale_id
   where i.promotion_id is not null and s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to;
  select count(*)::int sales_count, coalesce(sum(gross_cents),0)::int gross_cents,
         coalesce(sum(item_discount_cents + total_discount_cents),0)::int discount_cents,
         coalesce(sum(total_cents),0)::int total_cents, coalesce(sum(cost_cents),0)::int cost_cents,
         (count(*) filter (where imported))::int imported_count, coalesce(sum(total_cents) filter (where imported),0)::int imported_total_cents
    into v_sum from sales s where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to;
  select count(*)::int n, coalesce(sum(total_cents),0)::int total into v_canc
    from sales s where s.status = 'CANCELADA' and _local_date(s.created_at) between p_from and p_to;
  select coalesce(sum(cost_cents),0)::int into v_loss from losses l where _local_date(l.created_at) between p_from and p_to;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'summary', jsonb_build_object('sales_count', v_sum.sales_count, 'gross_cents', v_sum.gross_cents, 'discount_cents', v_sum.discount_cents,
      'total_cents', v_sum.total_cents, 'cost_cents', v_sum.cost_cents,
      -- margem só das vendas com itens (as importadas não têm custo)
      'margin_cents', v_sum.total_cents - v_sum.imported_total_cents - v_sum.cost_cents,
      'margin_pct_x100', case when v_sum.total_cents - v_sum.imported_total_cents > 0 then round((v_sum.total_cents - v_sum.imported_total_cents - v_sum.cost_cents) * 10000.0 / (v_sum.total_cents - v_sum.imported_total_cents))::int else 0 end,
      'imported_count', v_sum.imported_count, 'imported_total_cents', v_sum.imported_total_cents,
      'promo_items_count', v_promo.items, 'promo_sales_count', v_promo.sales, 'promo_total_cents', v_promo.total, 'promo_savings_cents', v_promo.savings,
      'ticket_medio_cents', case when v_sum.sales_count > 0 then round(v_sum.total_cents::numeric / v_sum.sales_count)::int else 0 end,
      'canceled_count', v_canc.n, 'canceled_total_cents', v_canc.total, 'loss_cost_cents', v_loss),
    'by_operator', coalesce((select jsonb_agg(x order by x.total_cents desc) from (
        select case when s.imported then 'Sistema antigo (importadas)' else u.name end as name, count(*)::int sales_count, sum(s.total_cents)::int total_cents
          from sales s join users u on u.id = s.user_id
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by 1) x), '[]'::jsonb),
    'by_payment', coalesce((select jsonb_agg(x order by x.total_cents desc) from (
        select p.method, count(*)::int n, sum(p.net_cents)::int total_cents,
          case p.method when 'dinheiro' then 'Dinheiro' when 'pix' then 'PIX' when 'debito' then 'Débito' when 'credito' then 'Crédito'
            when 'voucher' then 'Voucher' when 'nao_informado' then 'Não informado' else 'Fiado' end label
          from sale_payments p join sales s on s.id = p.sale_id
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by p.method) x), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(x order by x.total_cents desc) from (
        select c.name, c.color, sum(i.total_cents)::int total_cents, sum(round(i.unit_cost_cents::numeric * i.qty / 1000.0))::int cost_cents
          from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id join categories c on c.id = p.category_id
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by c.id, c.name, c.color) x), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(x order by x.total_cents desc) from (
        select p.id, p.name, p.unit, p.icon, sum(i.qty)::int qty, sum(i.total_cents)::int total_cents,
               sum(round(i.unit_cost_cents::numeric * i.qty / 1000.0))::int cost_cents,
               coalesce(sum(i.total_cents) filter (where i.promotion_id is not null), 0)::int promo_total_cents
          from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by p.id) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
        select _local_date(s.created_at) as day, count(*)::int sales_count, sum(s.total_cents)::int total_cents from sales s
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by 1) x), '[]'::jsonb),
    'losses', coalesce((select jsonb_agg(x order by x.cost_cents desc) from (
        select l.reason, count(*)::int n, sum(l.cost_cents)::int cost_cents,
          case l.reason when 'amadureceu' then 'Amadureceu' when 'estragou' then 'Estragou' when 'queda' then 'Queda' else 'Consumo interno' end label
          from losses l where _local_date(l.created_at) between p_from and p_to group by l.reason) x), '[]'::jsonb),
    'loss_items', coalesce((select jsonb_agg(x order by x.id desc) from (
        select l.id, l.created_at, l.reason, l.qty, l.cost_cents, l.note, p.name, p.unit, u.name as user_name
          from losses l join products p on p.id = l.product_id join users u on u.id = l.user_id
         where _local_date(l.created_at) between p_from and p_to) x), '[]'::jsonb));
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
  -- promoção em andamento/agendada do produto acaba junto
  update promotions set ended_at = now() where product_id = p_id and least(ends_at, coalesce(ended_at, ends_at)) > now();
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

-- v3.2: promoções. Só gerente/admin cria/encerra (RPC com _require_role; a tabela não aceita escrita direta pela API).

create or replace view v_promotions with (security_invoker = true) as
  select x.id, x.product_id, x.promo_price_cents, x.starts_at, x.ends_at, x.ended_at, x.note, x.created_at,
         least(x.ends_at, coalesce(x.ended_at, x.ends_at)) as ends_until,
         case when least(x.ends_at, coalesce(x.ended_at, x.ends_at)) <= now()
                then case when x.ended_at is not null and x.ended_at < x.ends_at then 'ENCERRADA' else 'EXPIRADA' end
              when x.starts_at > now() then 'AGENDADA' else 'ATIVA' end as status,
         p.name as product_name, p.icon as product_icon, p.unit as product_unit, p.code as product_code, p.price_cents as regular_price_cents,
         p.deleted_at is not null as product_deleted, u.name as created_by_name,
         (select count(*) from sale_items i join sales s on s.id = i.sale_id where i.promotion_id = x.id and s.status = 'FINALIZADA')::int as items_sold,
         (select coalesce(sum(i.total_cents), 0) from sale_items i join sales s on s.id = i.sale_id where i.promotion_id = x.id and s.status = 'FINALIZADA')::int as total_sold_cents
    from promotions x join products p on p.id = x.product_id left join users u on u.id = x.created_by;

-- p_data: { items: [{product_id, promo_price_cents}], starts_at, ends_at, note }
create or replace function promo_save(p_token text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; it jsonb; p products; v_start timestamptz; v_end timestamptz; v_price int; v_ids int[] := '{}'; v_id int; v_dup text;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  begin
    v_start := coalesce(nullif(p_data->>'starts_at', '')::timestamptz, now());
    v_end := (p_data->>'ends_at')::timestamptz;
  exception when others then perform _err('Data/hora da promoção inválida.'); end;
  if v_end is null then perform _err('Informe quando a promoção acaba.'); end if;
  if v_end <= v_start then perform _err('O fim da promoção precisa ser depois do início.'); end if;
  if v_end <= now() then perform _err('Essa promoção já teria acabado: escolha um fim no futuro.'); end if;
  if jsonb_typeof(p_data->'items') <> 'array' or jsonb_array_length(p_data->'items') = 0 then perform _err('Escolha pelo menos um produto.'); end if;
  for it in select * from jsonb_array_elements(p_data->'items') loop
    select * into p from products where id = (it->>'product_id')::int and deleted_at is null;
    if p.id is null then perform _err('Produto ' || coalesce(it->>'product_id', '?') || ' não encontrado.', 'NAO_ENCONTRADO'); end if;
    v_price := (it->>'promo_price_cents')::int;
    if v_price is null or v_price <= 0 then perform _err('Preço de promoção inválido para ' || p.name || '.'); end if;
    if v_price >= p.price_cents then perform _err('Preço de promoção de ' || p.name || ' precisa ser menor que o normal (' || _brl(p.price_cents) || ').'); end if;
    select to_char(x.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' a ' || to_char(least(x.ends_at, coalesce(x.ended_at, x.ends_at)) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
      into v_dup from promotions x where x.product_id = p.id and least(x.ends_at, coalesce(x.ended_at, x.ends_at)) > v_start and x.starts_at < v_end limit 1;
    if v_dup is not null then perform _err(p.name || ' já tem promoção nesse período (' || v_dup || '). Encerre a outra antes.', 'CONFLITO'); end if;
    insert into promotions(product_id, promo_price_cents, starts_at, ends_at, note, created_by)
    values (p.id, v_price, v_start, v_end, nullif(p_data->>'note', ''), u.id) returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  perform _audit(u.id, 'PROMO_CRIADA', 'promotions', null, jsonb_build_object('ids', to_jsonb(v_ids), 'items', p_data->'items', 'starts_at', v_start, 'ends_at', v_end));
  return coalesce((select jsonb_agg(to_jsonb(v) order by v.product_name) from v_promotions v where v.id = any(v_ids)), '[]'::jsonb);
end $$;

create or replace function promo_end(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; x promotions;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  select * into x from promotions where id = p_id for update;
  if x.id is null then perform _err('Promoção não encontrada.', 'NAO_ENCONTRADO'); end if;
  if least(x.ends_at, coalesce(x.ended_at, x.ends_at)) <= now() then perform _err('Essa promoção já acabou.', 'CONFLITO'); end if;
  update promotions set ended_at = now() where id = p_id;
  perform _audit(u.id, 'PROMO_ENCERRADA', 'promotion', p_id, jsonb_build_object('product_id', x.product_id, 'promo_price_cents', x.promo_price_cents,
    'antes_de_comecar', x.starts_at > now()));
  return (select to_jsonb(v) from v_promotions v where v.id = p_id);
end $$;

revoke all on function promo_save(text, jsonb), promo_end(text, int) from public, anon;
grant execute on function promo_save(text, jsonb), promo_end(text, int) to authenticated;
revoke all on v_promotions from anon;
grant select on v_promotions to authenticated;
grant select on promotions to authenticated;


-- v3.2: livro caixa (calendário). Só leitura. Inclui as vendas importadas do sistema antigo.

-- por dia no período: vendas (e importadas), aberturas/fechamentos, sangrias/suprimentos e diferença dos fechamentos
create or replace function cash_book_days(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  if p_to < p_from or p_to - p_from > 200 then perform _err('Período inválido (até 200 dias).'); end if;
  return coalesce((select jsonb_agg(x order by x.day) from (
    select d::date as day,
      coalesce(s.n, 0) sales_count, coalesce(s.total, 0) total_cents, coalesce(s.imp_n, 0) imported_count, coalesce(s.imp_total, 0) imported_total_cents,
      coalesce(o.n, 0) opened, coalesce(c.n, 0) closed, coalesce(c.diff, 0) diff_cents, coalesce(c.has_counts, false) has_counts,
      coalesce(m.sangria, 0) sangria_cents, coalesce(m.suprimento, 0) suprimento_cents
    from generate_series(p_from, p_to, interval '1 day') d
    left join (select _local_date(created_at) as day, count(*)::int as n, sum(total_cents)::int as total,
                      (count(*) filter (where imported))::int imp_n, coalesce(sum(total_cents) filter (where imported), 0)::int imp_total
                 from sales where status = 'FINALIZADA' and _local_date(created_at) between p_from and p_to group by 1) s on s.day = d::date
    left join (select _local_date(opened_at) as day, count(*)::int n from cash_sessions where _local_date(opened_at) between p_from and p_to group by 1) o on o.day = d::date
    left join (select _local_date(cs.closed_at) as day, count(*)::int n, sum(k.diff)::int diff, bool_or(k.diff is not null) has_counts
                 from cash_sessions cs left join (select session_id, sum(counted_cents - expected_cents)::int diff from cash_session_counts group by 1) k on k.session_id = cs.id
                where cs.closed_at is not null and _local_date(cs.closed_at) between p_from and p_to group by 1) c on c.day = d::date
    left join (select _local_date(created_at) as day, coalesce(abs(sum(amount_cents) filter (where type = 'SANGRIA')), 0)::int sangria,
                      coalesce(sum(amount_cents) filter (where type = 'SUPRIMENTO'), 0)::int suprimento
                 from cash_movements where _local_date(created_at) between p_from and p_to group by 1) m on m.day = d::date) x), '[]'::jsonb);
end $$;

-- detalhe de um dia ou período: vendas por forma de pagamento, sessões (abertura/fechamento/diferença) e movimentos
create or replace function cash_book_detail(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  if p_to < p_from or p_to - p_from > 400 then perform _err('Período inválido.'); end if;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'sales', (select jsonb_build_object('count', count(*)::int, 'total_cents', coalesce(sum(total_cents), 0)::int,
                'imported_count', (count(*) filter (where imported))::int, 'imported_total_cents', coalesce(sum(total_cents) filter (where imported), 0)::int,
                'canceled_count', (select count(*) from sales c where c.status = 'CANCELADA' and _local_date(c.created_at) between p_from and p_to)::int,
                'canceled_total_cents', (select coalesce(sum(total_cents), 0) from sales c where c.status = 'CANCELADA' and _local_date(c.created_at) between p_from and p_to)::int)
              from sales where status = 'FINALIZADA' and _local_date(created_at) between p_from and p_to),
    'by_payment', coalesce((select jsonb_agg(x order by x.total_cents desc) from (
        select p.method, count(*)::int n, sum(p.net_cents)::int total_cents from sale_payments p join sales s on s.id = p.sale_id
         where s.status = 'FINALIZADA' and _local_date(s.created_at) between p_from and p_to group by p.method) x), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(x order by x.opened_at) from (
        select cs.id, cs.terminal, cs.status, cs.opened_at, cs.closed_at, cs.opening_float_cents, uo.name opened_by_name, uc.name closed_by_name,
               (select sum(expected_cents) from cash_session_counts k where k.session_id = cs.id)::int expected_cents,
               (select sum(counted_cents) from cash_session_counts k where k.session_id = cs.id)::int counted_cents,
               (select sum(counted_cents - expected_cents) from cash_session_counts k where k.session_id = cs.id)::int diff_cents,
               (select coalesce(sum(total_cents), 0) from sales s where s.session_id = cs.id and s.status = 'FINALIZADA')::int sales_total_cents
          from cash_sessions cs join users uo on uo.id = cs.opened_by left join users uc on uc.id = cs.closed_by
         where _local_date(cs.opened_at) between p_from and p_to or (cs.closed_at is not null and _local_date(cs.closed_at) between p_from and p_to)) x), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(x order by x.created_at) from (
        select m.id, m.session_id, m.type, m.method, m.amount_cents, m.note, m.created_at, u.name user_name
          from cash_movements m join users u on u.id = m.user_id
         where m.type in ('ABERTURA','SANGRIA','SUPRIMENTO','RECEBIMENTO_FIADO','ESTORNO') and _local_date(m.created_at) between p_from and p_to
         order by m.created_at limit 500) x), '[]'::jsonb));
end $$;

revoke all on function cash_book_days(date, date), cash_book_detail(date, date) from public, anon;
grant execute on function cash_book_days(date, date), cash_book_detail(date, date) to authenticated;


revoke all on function sale_create(text, text, jsonb), report(date, date), product_delete(text, int) from public, anon;

grant execute on function sale_create(text, text, jsonb), report(date, date), product_delete(text, int) to authenticated;

commit;

notify pgrst, 'reload schema';
