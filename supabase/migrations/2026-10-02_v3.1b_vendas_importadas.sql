-- Migração v3.1b (2026-10-02): vendas importadas do sistema antigo. Idempotente.

begin;

-- v3.1: vendas importadas do sistema antigo: só o total (sem itens), pagamento "não informado", sem caixa e sem estoque.
-- client_uuid guarda o id original (reimportar não duplica).
alter table sales add column if not exists imported boolean not null default false;
alter table sales alter column session_id drop not null;
alter table sales drop constraint if exists sales_session_or_imported;
alter table sales add constraint sales_session_or_imported check (session_id is not null or imported);
alter table sale_payments drop constraint if exists sale_payments_method_check;
alter table sale_payments add constraint sale_payments_method_check check (method in ('dinheiro','pix','debito','credito','voucher','fiado','nao_informado'));

create or replace view v_sales_list with (security_invoker = true) as
  select s.id, s.number, s.status, s.total_cents, s.created_at, s.terminal, s.offline, _local_date(s.created_at) as local_date,
         u.name as user_name, c.name as customer_name,
         (select string_agg(method, '+' order by id) from sale_payments where sale_id = s.id) as methods,
         (select count(*) from sale_items where sale_id = s.id)::int as items_count, s.imported
    from sales s join users u on u.id = s.user_id left join customers c on c.id = s.customer_id;

grant select on v_sales_list to authenticated;
revoke all on v_sales_list from anon;

create or replace function sale_cancel(p_token text, p_terminal text, p_id int, p_reason text default '', p_manager_pin text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_by int; s sales; orig cash_sessions; sess cash_sessions; it record; pay record;
begin
  u := _op(p_token);
  v_by := _authorize_manager(u, p_manager_pin, 'Cancelamento de venda');
  select * into s from sales where id = p_id for update;
  if s.id is null then perform _err('Venda não encontrada.', 'NAO_ENCONTRADO'); end if;
  if s.status <> 'FINALIZADA' then perform _err('Venda já cancelada.', 'CONFLITO'); end if;
  if s.imported then perform _err('Venda importada do sistema antigo: não dá para cancelar aqui.', 'CONFLITO'); end if;
  if _local_date(s.created_at) <> _today() then perform _err('Só dá para cancelar venda do dia.', 'FORA_DO_DIA'); end if;
  select * into orig from cash_sessions where id = s.session_id;
  if orig.status = 'ABERTO' then sess := orig; else sess := _open_session(p_terminal); end if;
  if sess.id is null then perform _err('Abra o caixa para estornar esta venda.', 'CAIXA_FECHADO'); end if;
  update sales set status = 'CANCELADA', canceled_at = now(), canceled_by = u.id, cancel_authorized_by = v_by, cancel_reason = nullif(p_reason, '')
   where id = s.id;
  for it in select * from sale_items where sale_id = s.id loop
    perform _apply_stock(it.product_id, it.qty, 'CANCELAMENTO', u.id, null, 'venda', s.id, null, 'Cancelamento venda nº ' || s.number, false);
  end loop;
  for pay in select * from sale_payments where sale_id = s.id loop
    if pay.net_cents <> 0 then
      perform _cash_move(sess.id, 'ESTORNO', pay.method, -pay.net_cents, u.id, 'venda', s.id, 'Estorno venda nº ' || s.number, v_by);
    end if;
    if pay.method = 'fiado' and s.customer_id is not null then
      perform _ledger(s.customer_id, 'ESTORNO', -pay.net_cents, u.id, s.id, sess.id, 'fiado', 'Cancelamento venda nº ' || s.number, false);
    end if;
  end loop;
  perform _audit(u.id, 'VENDA_CANCELADA', 'sale', s.id, jsonb_build_object('number', s.number, 'total', s.total_cents, 'reason', p_reason, 'authorized_by', v_by));
  return sale_get(s.id);
end $$;

create or replace function report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sum record; v_canc record; v_loss int;
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
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
               sum(round(i.unit_cost_cents::numeric * i.qty / 1000.0))::int cost_cents
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

revoke all on function sale_cancel(text, text, int, text, text), report(date, date) from public, anon;

grant execute on function sale_cancel(text, text, int, text, text), report(date, date) to authenticated;

commit;

notify pgrst, 'reload schema';
