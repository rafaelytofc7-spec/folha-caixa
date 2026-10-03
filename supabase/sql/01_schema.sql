-- Folha Caixa — esquema Postgres (Supabase)
-- Dinheiro em centavos (integer). Quantidade em milésimos (integer): KG = gramas.
-- Escrita sensível SÓ por funções RPC (SECURITY DEFINER). RLS em todas as tabelas.

create extension if not exists pgcrypto with schema extensions;

-- (contas: cada pessoa tem usuário+senha no Supabase Auth, ligado a users.auth_uid — ver 05_accounts.sql)
drop table if exists store_accounts cascade;

create table if not exists store_settings (
  id int primary key check (id = 1),
  name text not null default 'Banca Folha',
  legal_name text not null default '',
  cnpj text not null default '',
  address text not null default '',
  phone text not null default '',
  receipt_footer text not null default 'Obrigado, volte sempre!',
  discount_limit_pct int not null default 1000,
  allow_negative_stock boolean not null default false,
  expiry_alert_days int not null default 2,
  printer_host text not null default '',
  printer_port int not null default 9100,
  scale_label_mode text not null default 'peso' check (scale_label_mode in ('peso','preco')),
  scale_code_digits int not null default 5,
  last_sale_number int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id serial primary key,
  name text not null,
  username text unique,                                   -- login (vira usuario@folhacaixa.app no Supabase Auth)
  auth_uid uuid unique references auth.users(id) on delete set null,
  role text not null check (role in ('admin','gerente','operador')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table users add column if not exists username text unique;
alter table users add column if not exists auth_uid uuid unique references auth.users(id) on delete set null;
-- hash do PIN separado (sem política de leitura: ninguém lê pela API)
create table if not exists user_pins (
  user_id int primary key references users(id) on delete cascade,
  pin_hash text not null
);
create table if not exists op_sessions (
  token text primary key,
  user_id int not null references users(id) on delete cascade,
  auth_uid uuid not null,
  terminal text,
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id serial primary key,
  name text not null,
  slug text not null unique,
  color text not null,
  icon text not null default ''
);

create table if not exists products (
  id serial primary key,
  code text not null unique,
  ean text unique,
  name text not null,
  category_id int not null references categories(id),
  unit text not null default 'KG' check (unit in ('KG','UN','BANDEJA','MACO','DUZIA','PCT')),
  price_cents int not null check (price_cents >= 0),
  cost_cents int not null default 0 check (cost_cents >= 0),
  stock_qty int not null default 0,
  min_stock int not null default 0,
  active boolean not null default true,
  allow_negative boolean not null default false,
  shortcut_pos int unique check (shortcut_pos is null or shortcut_pos between 1 and 24),
  icon text not null default '',
  ncm text, cfop text, cst text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_name on products(name);
-- v3.1: produto apagado com histórico fica escondido (deleted_at preenchido); sem histórico é apagado de vez
alter table products add column if not exists deleted_at timestamptz;

create table if not exists lots (
  id serial primary key,
  product_id int not null references products(id),
  lot_code text,
  expiry_date date,
  qty_initial int not null,
  qty_left int not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_lots_product on lots(product_id);

create table if not exists suppliers (
  id serial primary key,
  name text not null,
  phone text not null default '',
  doc text not null default '',
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists purchases (
  id serial primary key,
  supplier_id int references suppliers(id),
  user_id int not null references users(id),
  total_cents int not null default 0,
  items_count int not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists stock_movements (
  id bigserial primary key,
  product_id int not null references products(id),
  type text not null check (type in ('ENTRADA','VENDA','CANCELAMENTO','AJUSTE','PERDA','INICIAL')),
  qty int not null,
  balance_after int not null,
  unit_cost_cents int not null default 0,
  ref_type text, ref_id bigint,
  lot_id int references lots(id),
  note text,
  user_id int references users(id),
  supplier_id int references suppliers(id),
  created_at timestamptz not null default now()
);
alter table stock_movements add column if not exists supplier_id int references suppliers(id);
create index if not exists idx_stock_mov_product on stock_movements(product_id, id);

create table if not exists losses (
  id serial primary key,
  product_id int not null references products(id),
  qty int not null check (qty > 0),
  reason text not null check (reason in ('amadureceu','estragou','queda','consumo_interno')),
  cost_cents int not null default 0,
  note text,
  user_id int not null references users(id),
  authorized_by int references users(id),
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id serial primary key,
  name text not null,
  phone text not null default '',
  doc text not null default '',
  credit_limit_cents int not null default 0,
  balance_cents int not null default 0,
  active boolean not null default true,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists cash_sessions (
  id serial primary key,
  terminal text not null,
  status text not null default 'ABERTO' check (status in ('ABERTO','FECHADO')),
  opened_by int not null references users(id),
  opened_at timestamptz not null default now(),
  opening_float_cents int not null default 0,
  closed_by int references users(id),
  closed_at timestamptz,
  note text
);
create unique index if not exists ux_cash_one_open on cash_sessions(terminal) where status = 'ABERTO';

create table if not exists cash_session_counts (
  session_id int not null references cash_sessions(id),
  method text not null,
  expected_cents int not null,
  counted_cents int not null,
  primary key (session_id, method)
);

create table if not exists cash_movements (
  id bigserial primary key,
  session_id int not null references cash_sessions(id),
  type text not null check (type in ('ABERTURA','VENDA','SANGRIA','SUPRIMENTO','ESTORNO','RECEBIMENTO_FIADO')),
  method text not null check (method in ('dinheiro','pix','debito','credito','voucher','fiado')),
  amount_cents int not null,
  ref_type text, ref_id bigint,
  note text,
  user_id int not null references users(id),
  authorized_by int references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_mov_session on cash_movements(session_id);

create table if not exists sales (
  id serial primary key,
  number int not null unique,
  client_uuid uuid unique,                -- idempotência (fila offline)
  offline boolean not null default false,
  session_id int not null references cash_sessions(id),
  terminal text not null,
  user_id int not null references users(id),
  customer_id int references customers(id),
  status text not null default 'FINALIZADA' check (status in ('FINALIZADA','CANCELADA')),
  gross_cents int not null,
  item_discount_cents int not null default 0,
  total_discount_cents int not null default 0,
  total_cents int not null,
  paid_cents int not null,
  change_cents int not null default 0,
  cost_cents int not null default 0,
  discount_authorized_by int references users(id),
  created_at timestamptz not null default now(),
  canceled_at timestamptz, canceled_by int references users(id),
  cancel_authorized_by int references users(id), cancel_reason text
);
create index if not exists idx_sales_created on sales(created_at);

create table if not exists sale_items (
  id serial primary key,
  sale_id int not null references sales(id),
  product_id int not null references products(id),
  name text not null,
  unit text not null,
  qty int not null,
  unit_price_cents int not null,
  gross_cents int not null,
  discount_cents int not null default 0,
  total_cents int not null,
  unit_cost_cents int not null default 0
);
create index if not exists idx_sale_items_sale on sale_items(sale_id);

create table if not exists sale_payments (
  id serial primary key,
  sale_id int not null references sales(id),
  method text not null check (method in ('dinheiro','pix','debito','credito','voucher','fiado')),
  amount_cents int not null,
  net_cents int not null
);
create index if not exists idx_sale_payments_sale on sale_payments(sale_id);
-- v3.1: vendas importadas do sistema antigo: só o total (sem itens), pagamento "não informado", sem caixa e sem estoque.
-- client_uuid guarda o id original (reimportar não duplica).
alter table sales add column if not exists imported boolean not null default false;
alter table sales alter column session_id drop not null;
alter table sales drop constraint if exists sales_session_or_imported;
alter table sales add constraint sales_session_or_imported check (session_id is not null or imported);
alter table sale_payments drop constraint if exists sale_payments_method_check;
alter table sale_payments add constraint sale_payments_method_check check (method in ('dinheiro','pix','debito','credito','voucher','fiado','nao_informado'));

create table if not exists held_sales (
  id serial primary key,
  terminal text not null,
  user_id int not null references users(id),
  label text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists customer_ledger (
  id serial primary key,
  customer_id int not null references customers(id),
  type text not null check (type in ('COMPRA','LANCAMENTO','RECEBIMENTO','ESTORNO')),
  amount_cents int not null,
  balance_after int not null,
  method text,
  sale_id int references sales(id),
  session_id int references cash_sessions(id),
  note text,
  user_id int not null references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_ledger_customer on customer_ledger(customer_id, id);

create table if not exists fiscal_documents (
  id serial primary key,
  sale_id int not null references sales(id),
  provider text not null,
  status text not null,
  access_key text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  user_id int references users(id),
  action text not null,
  entity text,
  entity_id bigint,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_log(created_at);

-- ---------- RLS ----------
-- "conta da loja" = login (Supabase Auth) ligado a um usuário ativo da banca
create or replace function is_store_account() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from users where auth_uid = auth.uid() and active);
$$;

do $$
declare t text;
begin
  foreach t in array array['store_settings','users','suppliers','purchases','user_pins','op_sessions','categories','products','lots',
    'stock_movements','losses','customers','cash_sessions','cash_session_counts','cash_movements','sales','sale_items',
    'sale_payments','held_sales','customer_ledger','fiscal_documents','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
    execute format('revoke all on %I from anon', t);
    execute format('drop policy if exists leitura_loja on %I', t);
    -- tabelas secretas ficam sem política nenhuma (ninguém lê pela API)
    if t not in ('user_pins','op_sessions') then
      execute format('create policy leitura_loja on %I for select to authenticated using (is_store_account())', t);
    end if;
  end loop;
end $$;
revoke all on user_pins, op_sessions from authenticated;

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

-- v3.3: encomendas (cliente pede, avisa quando chega pelo WhatsApp, conclui virando venda de verdade)
create table if not exists orders (
  id serial primary key,
  customer_id int references customers(id),
  customer_name text not null,
  phone text not null default '',              -- só dígitos, com DDD (ex.: 11987654321)
  paid boolean not null default false,          -- já pago antes de chegar (o dinheiro entra no caixa ao concluir)
  paid_method text check (paid_method in ('dinheiro','pix','debito','credito','voucher','fiado')),
  delivery text not null default 'a_combinar' check (delivery in ('buscar','entrega','a_combinar')),
  address text not null default '',
  note text not null default '',
  status text not null default 'AGUARDANDO' check (status in ('AGUARDANDO','AVISADA','PRONTA','CONCLUIDA','CANCELADA')),
  notified_at timestamptz, notified_count int not null default 0, notified_by int references users(id),
  ready_at timestamptz,
  concluded_at timestamptz, concluded_by int references users(id),
  canceled_at timestamptz, canceled_by int references users(id), cancel_reason text,
  sale_id int references sales(id),
  imported boolean not null default false,      -- histórico do sistema antigo (sem venda, sem estoque)
  legacy_id text unique,
  created_by int references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_orders_status on orders(status, created_at);
create table if not exists order_items (
  id serial primary key,
  order_id int not null references orders(id) on delete cascade,
  product_id int references products(id),       -- null = item livre (ex.: "queijo da serra")
  name text not null,
  unit text not null default 'UN',
  qty int,                                      -- milésimos (1000 = 1 un / 1 kg); null = não informado (importadas)
  line_cents int,                               -- valor do item; null = a definir
  pos int not null default 0
);
create index if not exists idx_order_items_order on order_items(order_id);
alter table orders enable row level security;
alter table order_items enable row level security;
revoke insert, update, delete, truncate on orders, order_items from anon, authenticated;
revoke all on orders, order_items from anon;
drop policy if exists leitura_loja on orders;
create policy leitura_loja on orders for select to authenticated using (is_store_account());
drop policy if exists leitura_loja on order_items;
create policy leitura_loja on order_items for select to authenticated using (is_store_account());
-- venda de encomenda pode ter item livre (sem produto do cadastro)
alter table sale_items alter column product_id drop not null;

-- v3.4: apagar venda (só admin) = exclusão lógica: some de relatórios/Hoje/livro caixa/histórico, mas fica guardada (quem, quando, motivo).
alter table sales add column if not exists deleted_at timestamptz;
alter table sales add column if not exists deleted_by int references users(id);
alter table sales add column if not exists delete_reason text;
alter table sales add column if not exists deleted_prev_status text;   -- FINALIZADA ou CANCELADA (antes de apagar)
alter table sales drop constraint if exists sales_status_check;
alter table sales add constraint sales_status_check check (status in ('FINALIZADA','CANCELADA','EXCLUIDA'));
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in ('ENTRADA','VENDA','CANCELAMENTO','AJUSTE','PERDA','INICIAL','EXCLUSAO'));
