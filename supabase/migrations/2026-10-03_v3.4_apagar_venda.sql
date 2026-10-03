-- Migração v3.4 (2026-10-03): apagar venda (só admin, exclusão lógica com estorno). Idempotente.

begin;
-- v3.4: apagar venda (só admin) = exclusão lógica: some de relatórios/Hoje/livro caixa/histórico, mas fica guardada (quem, quando, motivo).
alter table sales add column if not exists deleted_at timestamptz;
alter table sales add column if not exists deleted_by int references users(id);
alter table sales add column if not exists delete_reason text;
alter table sales add column if not exists deleted_prev_status text;   -- FINALIZADA ou CANCELADA (antes de apagar)
alter table sales drop constraint if exists sales_status_check;
alter table sales add constraint sales_status_check check (status in ('FINALIZADA','CANCELADA','EXCLUIDA'));
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in ('ENTRADA','VENDA','CANCELAMENTO','AJUSTE','PERDA','INICIAL','EXCLUSAO'));

create or replace function sale_get(p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  select to_jsonb(s) || jsonb_build_object('user_name', u.name, 'customer_name', c.name, 'customer_balance_cents', c.balance_cents,
      'canceled_by_name', cu.name, 'deleted_by_name', du.name,
      -- v3.4: situação do caixa da venda (para explicar o que acontece ao apagar)
      'session_status', (select cs.status from cash_sessions cs where cs.id = s.session_id),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from sale_items i where i.sale_id = s.id), '[]'::jsonb),
      'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from sale_payments p where p.sale_id = s.id), '[]'::jsonb),
      'fiscal', (select jsonb_build_object('provider', f.provider, 'status', f.status, 'access_key', f.access_key)
                   from fiscal_documents f where f.sale_id = s.id order by f.id desc limit 1),
      -- v3.3: venda que veio de uma encomenda
      'order', (select jsonb_build_object('id', o.id, 'customer_name', o.customer_name, 'phone', o.phone, 'delivery', o.delivery, 'address', o.address)
                  from orders o where o.sale_id = s.id limit 1))
    into r
    from sales s join users u on u.id = s.user_id left join customers c on c.id = s.customer_id left join users cu on cu.id = s.canceled_by left join users du on du.id = s.deleted_by
   where s.id = p_id;
  if r is null then perform _err('Venda não encontrada.', 'NAO_ENCONTRADO'); end if;
  return r;
end $$;

create or replace function sale_cancel(p_token text, p_terminal text, p_id int, p_reason text default '', p_manager_pin text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_by int; s sales; orig cash_sessions; sess cash_sessions; it record; pay record;
begin
  u := _op(p_token);
  v_by := _authorize_manager(u, p_manager_pin, 'Cancelamento de venda');
  select * into s from sales where id = p_id for update;
  if s.id is null then perform _err('Venda não encontrada.', 'NAO_ENCONTRADO'); end if;
  if s.status = 'EXCLUIDA' then perform _err('Venda apagada pelo administrador.', 'CONFLITO'); end if;
  if s.status <> 'FINALIZADA' then perform _err('Venda já cancelada.', 'CONFLITO'); end if;
  if s.imported then perform _err('Venda importada do sistema antigo: não dá para cancelar aqui.', 'CONFLITO'); end if;
  if _local_date(s.created_at) <> _today() then perform _err('Só dá para cancelar venda do dia.', 'FORA_DO_DIA'); end if;
  select * into orig from cash_sessions where id = s.session_id;
  if orig.status = 'ABERTO' then sess := orig; else sess := _open_session(p_terminal); end if;
  if sess.id is null then perform _err('Abra o caixa para estornar esta venda.', 'CAIXA_FECHADO'); end if;
  update sales set status = 'CANCELADA', canceled_at = now(), canceled_by = u.id, cancel_authorized_by = v_by, cancel_reason = nullif(p_reason, '')
   where id = s.id;
  for it in select * from sale_items where sale_id = s.id and product_id is not null loop -- item livre de encomenda não tem estoque
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
  -- v3.3: venda de encomenda cancelada: a encomenda volta para "Pronta" (o dinheiro foi estornado, então fica "a pagar")
  update orders set status = 'PRONTA', sale_id = null, concluded_at = null, concluded_by = null, paid = false, paid_method = null, updated_at = now()
   where sale_id = s.id;
  perform _audit(u.id, 'VENDA_CANCELADA', 'sale', s.id, jsonb_build_object('number', s.number, 'total', s.total_cents, 'reason', p_reason, 'authorized_by', v_by));
  return sale_get(s.id);
end $$;

create or replace view v_sales_list with (security_invoker = true) as
  select s.id, s.number, s.status, s.total_cents, s.created_at, s.terminal, s.offline, _local_date(s.created_at) as local_date,
         u.name as user_name, c.name as customer_name,
         (select string_agg(method, '+' order by id) from sale_payments where sale_id = s.id) as methods,
         (select count(*) from sale_items where sale_id = s.id)::int as items_count, s.imported,
         s.deleted_at, s.delete_reason, (select d.name from users d where d.id = s.deleted_by) as deleted_by_name
    from sales s join users u on u.id = s.user_id left join customers c on c.id = s.customer_id;

-- v3.4: APAGAR VENDA (só administrador). Diferente de "Cancelar" (devolução no dia, gerente):
--  - qualquer dia, inclusive venda importada do sistema antigo e venda de encomenda;
--  - exclusão lógica: status EXCLUIDA + quem/quando/motivo; a venda some dos totais (tudo filtra FINALIZADA) e fica no histórico de auditoria;
--  - estorna o que a venda fez: estoque volta (movimento EXCLUSAO "Estorno por exclusão"), caixa e fiado.
--    Caixa ABERTO: lança ESTORNO no próprio caixa da venda (o esperado diminui).
--    Caixa FECHADO: lança ESTORNO no caixa da venda só como registro; o que foi conferido no fechamento não muda.
--    Venda já CANCELADA: o cancelamento já estornou tudo; só some da lista.
--  - venda de encomenda: a encomenda volta para "Pronta" e "a pagar" (dá para concluir de novo ou cancelar).
create or replace function sale_delete(p_token text, p_id int, p_reason text, p_confirm_number int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; s sales; sess cash_sessions; it record; pay record; v_note text; v_reason text := trim(coalesce(p_reason, ''));
  v_stock int := 0; v_cash int := 0; v_fiado int := 0; v_order int; v_snapshot jsonb;
begin
  u := _op(p_token);
  if u.role <> 'admin' then perform _err('Só o administrador pode apagar venda.', 'PROIBIDO'); end if;
  if length(v_reason) < 3 then perform _err('Escreva o motivo para apagar a venda.', 'DADOS'); end if;
  select * into s from sales where id = p_id for update;
  if s.id is null then perform _err('Venda não encontrada.', 'NAO_ENCONTRADO'); end if;
  if s.status = 'EXCLUIDA' then perform _err('Esta venda já foi apagada.', 'CONFLITO'); end if;
  if p_confirm_number is distinct from s.number then perform _err('Para confirmar, digite o número da venda: ' || s.number || '.', 'CONFIRMAR'); end if;
  v_snapshot := sale_get(s.id);
  v_note := 'Estorno por exclusão da venda nº ' || s.number;
  if s.session_id is not null then select * into sess from cash_sessions where id = s.session_id; end if;
  if s.status = 'FINALIZADA' then
    for it in select * from sale_items where sale_id = s.id and product_id is not null loop
      perform _apply_stock(it.product_id, it.qty, 'EXCLUSAO', u.id, null, 'venda', s.id, null, v_note, false);
      v_stock := v_stock + 1;
    end loop;
    for pay in select * from sale_payments where sale_id = s.id and method <> 'nao_informado' loop
      if sess.id is not null and pay.net_cents <> 0 then
        perform _cash_move(sess.id, 'ESTORNO', pay.method, -pay.net_cents, u.id, 'venda', s.id,
          v_note || case when sess.status = 'ABERTO' then '' else ' (caixa já fechado: a conferência não muda)' end, u.id);
        v_cash := v_cash + pay.net_cents;
      end if;
      if pay.method = 'fiado' and s.customer_id is not null and pay.net_cents <> 0 then
        perform _ledger(s.customer_id, 'ESTORNO', -pay.net_cents, u.id, s.id, sess.id, 'fiado', v_note, false);
        v_fiado := v_fiado + pay.net_cents;
      end if;
    end loop;
    update orders set status = 'PRONTA', sale_id = null, concluded_at = null, concluded_by = null, paid = false, paid_method = null, updated_at = now(),
           note = concat_ws(' · ', nullif(note, ''), 'Venda nº ' || s.number || ' apagada pelo administrador (' || v_reason || ')')
     where sale_id = s.id returning id into v_order;
  end if;
  update sales set status = 'EXCLUIDA', deleted_at = now(), deleted_by = u.id, delete_reason = v_reason, deleted_prev_status = s.status where id = s.id;
  perform _audit(u.id, 'VENDA_EXCLUIDA', 'sale', s.id, jsonb_build_object('number', s.number, 'total', s.total_cents, 'created_at', s.created_at,
    'prev_status', s.status, 'imported', s.imported, 'reason', v_reason, 'session_id', s.session_id, 'session_status', sess.status,
    'stock_lines', v_stock, 'cash_reversed', v_cash, 'fiado_reversed', v_fiado, 'order_id', v_order, 'sale', v_snapshot));
  return sale_get(s.id) || jsonb_build_object('effects', jsonb_build_object('stock_lines', v_stock, 'cash_reversed_cents', v_cash,
    'session_status', sess.status, 'fiado_reversed_cents', v_fiado, 'order_id', v_order, 'prev_status', s.status));
end $$;

-- Permissões: nada para anon; authenticated só executa as RPCs públicas e lê views/tabelas (RLS).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('pin_login','pin_logout','op_me','session_summary','cash_open','cash_move','cash_close','sale_get','sale_create',
        'sale_cancel','held_create','held_resume','stock_entry','stock_adjust','stock_loss','expiring_lots','top_sellers','product_save',
        'shortcuts_set','customer_save','customer_charge','customer_receive','customer_statement','settings_update','user_save',
        'app_status','report','is_store_account','self_login','pin_users','users_list','supplier_save','purchase_entry',
        'prices_update','app_needs_setup','product_usage','product_delete','product_restore','promo_save','promo_end','cash_book_days','cash_book_detail',
        'order_save','order_notify','order_ready','order_cancel','order_conclude','sale_delete') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    -- só a Edge Function "accounts" (service_role, no servidor) cria contas
    if f.proname in ('account_bootstrap','account_create','account_target','account_check_admin','app_needs_setup') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
    if f.proname = 'app_needs_setup' then
      execute format('grant execute on function %s to anon', f.sig);
    end if;
  end loop;
end $$;
-- funções puras usadas dentro das views (security_invoker) precisam ser executáveis por quem consulta
grant execute on function _local_date(timestamptz) to authenticated;

revoke all on v_products, v_products_deleted, v_promotions, v_orders, v_cash_sessions, v_sales_list, v_losses, v_stock_movements, v_held_sales, v_audit, v_purchases from anon;
grant select on v_products, v_products_deleted, v_promotions, v_orders, v_cash_sessions, v_sales_list, v_losses, v_stock_movements, v_held_sales, v_audit, v_purchases to authenticated;
-- leitura das tabelas comuns pelo authenticated (RLS filtra: só conta da loja)
grant select on store_settings, users, suppliers, purchases, categories, products, lots, stock_movements, losses, customers, cash_sessions,
  cash_session_counts, cash_movements, sales, sale_items, sale_payments, held_sales, customer_ledger, fiscal_documents, audit_log, promotions, orders, order_items to authenticated;
-- PostgREST: recarrega o cache do esquema
notify pgrst, 'reload schema';
commit;
