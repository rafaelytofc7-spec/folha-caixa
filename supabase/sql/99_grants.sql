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
        'prices_update','app_needs_setup') then
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

revoke all on v_products, v_cash_sessions, v_sales_list, v_losses, v_stock_movements, v_held_sales, v_audit, v_purchases from anon;
grant select on v_products, v_cash_sessions, v_sales_list, v_losses, v_stock_movements, v_held_sales, v_audit, v_purchases to authenticated;
-- leitura das tabelas comuns pelo authenticated (RLS filtra: só conta da loja)
grant select on store_settings, users, suppliers, purchases, categories, products, lots, stock_movements, losses, customers, cash_sessions,
  cash_session_counts, cash_movements, sales, sale_items, sale_payments, held_sales, customer_ledger, fiscal_documents, audit_log to authenticated;
-- PostgREST: recarrega o cache do esquema
notify pgrst, 'reload schema';
