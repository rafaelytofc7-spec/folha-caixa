-- ===================== Contas (usuário + senha), fornecedores, compras, preços =====================
-- Login: usuário "joao" vira o e-mail interno joao@folhacaixa.app no Supabase Auth (ninguém recebe e-mail).
-- O cadastro público do Supabase fica DESLIGADO; contas só nascem pela Edge Function "accounts"
-- (service_role só no servidor), que chama as funções account_* abaixo (executáveis apenas por service_role).

-- Primeiro acesso? (a tela de login mostra "Criar cadastro" só quando ainda não há nenhuma conta)
create or replace function app_needs_setup() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from users where auth_uid is not null);
$$;

create or replace function _check_username(p text) returns text language plpgsql immutable as $$
begin
  if p is null or p !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    perform _err('Usuário deve ter de 3 a 30 letras minúsculas, números, ponto, hífen ou _ (sem espaço e sem acento).', 'USUARIO_INVALIDO');
  end if;
  return p;
end $$;

-- Primeira conta da banca: vira ADMIN. Trava a tabela para dois cadastros simultâneos não virarem dois admins.
create or replace function account_bootstrap(p_auth_uid uuid, p_name text, p_username text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id int;
begin
  lock table users in exclusive mode;
  if exists (select 1 from users where auth_uid is not null) then
    perform _err('Cadastro fechado: a banca já tem administrador. Peça ao admin para criar seu usuário.', 'CADASTRO_FECHADO');
  end if;
  if trim(coalesce(p_name, '')) = '' then perform _err('Informe seu nome.'); end if;
  perform _check_username(p_username);
  if p_pin is null or p_pin !~ '^\d{4}$' then perform _err('O PIN precisa ter 4 dígitos.', 'PIN_INVALIDO'); end if;
  if exists (select 1 from users where username = p_username) then perform _err('Esse usuário já existe.', 'USUARIO_EXISTE'); end if;
  insert into users(name, username, auth_uid, role, active) values (trim(p_name), p_username, p_auth_uid, 'admin', true) returning id into v_id;
  insert into user_pins(user_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf', 8)));
  perform _audit(v_id, 'PRIMEIRO_ACESSO', 'user', v_id, jsonb_build_object('username', p_username, 'role', 'admin'));
  return jsonb_build_object('id', v_id, 'username', p_username, 'role', 'admin');
end $$;

-- Confere que quem chama é admin: token do PIN (op_sessions) aberto pelo mesmo login (auth uid)
create or replace function _admin_from_token(p_token text, p_caller uuid) returns users
language plpgsql stable security definer set search_path = public as $$
declare u users;
begin
  select u2.* into u from op_sessions s join users u2 on u2.id = s.user_id
   where s.token = p_token and s.auth_uid = p_caller and u2.active and s.created_at > now() - interval '30 days';
  if u.id is null then perform _err('Entre de novo no caixa.', 'SEM_PIN'); end if;
  if u.role <> 'admin' then perform _err('Só o administrador cria usuários e troca senhas.', 'PROIBIDO'); end if;
  if not exists (select 1 from users where auth_uid = p_caller and active) then perform _err('Login não autorizado.', 'SEM_LOGIN'); end if;
  return u;
end $$;

-- Admin cria funcionário (gerente/operador/admin) com usuário+senha (+ PIN opcional para trocar de operador e autorizar)
create or replace function account_create(p_token text, p_caller uuid, p_auth_uid uuid, p_name text, p_username text, p_role text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a users; v_id int;
begin
  a := _admin_from_token(p_token, p_caller);
  if trim(coalesce(p_name, '')) = '' then perform _err('Informe o nome.'); end if;
  perform _check_username(p_username);
  if p_role not in ('admin','gerente','operador') then perform _err('Papel inválido.'); end if;
  if p_pin is not null and p_pin <> '' and p_pin !~ '^\d{4}$' then perform _err('O PIN precisa ter 4 dígitos.', 'PIN_INVALIDO'); end if;
  if exists (select 1 from users where username = p_username) then perform _err('Esse usuário já existe.', 'USUARIO_EXISTE'); end if;
  insert into users(name, username, auth_uid, role, active) values (trim(p_name), p_username, p_auth_uid, p_role, true) returning id into v_id;
  if p_pin is not null and p_pin <> '' then insert into user_pins(user_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf', 8))); end if;
  perform _audit(a.id, 'USUARIO_CRIADO', 'user', v_id, jsonb_build_object('name', p_name, 'username', p_username, 'role', p_role, 'pin', p_pin is not null and p_pin <> ''));
  return jsonb_build_object('id', v_id, 'username', p_username, 'role', p_role);
end $$;

-- Admin troca a senha de alguém: devolve o auth uid do alvo (a Edge Function faz a troca no Auth)
create or replace function account_target(p_token text, p_caller uuid, p_user_id int) returns uuid
language plpgsql security definer set search_path = public as $$
declare a users; v uuid;
begin
  a := _admin_from_token(p_token, p_caller);
  select auth_uid into v from users where id = p_user_id;
  if v is null then perform _err('Usuário sem login.', 'NAO_ENCONTRADO'); end if;
  perform _audit(a.id, 'SENHA_REDEFINIDA', 'user', p_user_id, null);
  return v;
end $$;

-- Depois do login com usuário+senha: abre a sessão do caixa para a própria pessoa (sem PIN)
create or replace function self_login(p_terminal text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_token text;
begin
  select * into u from users where auth_uid = auth.uid() and active;
  if u.id is null then perform _err('Seu usuário está inativo ou não existe. Fale com o administrador.', 'SEM_LOGIN'); end if;
  -- só logo depois de digitar a senha (amr = momento do login). Assim quem trocou de operador por PIN
  -- não consegue "voltar" para o dono do login sem saber a senha.
  if coalesce((select max((a->>'timestamp')::bigint) from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) a
               where a->>'method' = 'password'), 0) < extract(epoch from now())::bigint - 600 then
    perform _err('Digite a senha de novo para entrar.', 'SENHA_DE_NOVO');
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into op_sessions(token, user_id, auth_uid, terminal) values (v_token, u.id, auth.uid(), p_terminal);
  perform _audit(u.id, 'LOGIN', 'user', u.id, jsonb_build_object('terminal', p_terminal, 'via', 'senha'));
  return jsonb_build_object('token', v_token, 'user', jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role, 'username', u.username));
end $$;

-- Quem pode trocar de operador por PIN neste aparelho (só quem tem PIN)
create or replace function pin_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role, 'username', u.username) order by u.id)
    from users u where u.active and exists (select 1 from user_pins p where p.user_id = u.id)), '[]'::jsonb);
end $$;

-- Lista de usuários para a tela do admin (com "tem PIN" e "tem login")
create or replace function users_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_store_account() then perform _err('Entre com usuário e senha.', 'SEM_LOGIN'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role, 'username', u.username, 'active', u.active,
      'created_at', u.created_at, 'has_pin', exists (select 1 from user_pins p where p.user_id = u.id), 'has_login', u.auth_uid is not null) order by u.id)
    from users u), '[]'::jsonb);
end $$;

-- user_save (03_api) continua para nome/papel/ativo/PIN; criar usuário agora só pela Edge Function (precisa de login)
create or replace function user_save(p_token text, p_id int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_id int; v_pin text := nullif(p_data->>'pin', ''); v_role text := p_data->>'role'; v_active boolean := coalesce((p_data->>'active')::boolean, true);
begin
  u := _op(p_token);
  perform _require_role(u, array['admin']);
  if p_id is null then perform _err('Crie usuários em Configurações › Usuários (usuário + senha).'); end if;
  if trim(coalesce(p_data->>'name', '')) = '' then perform _err('Nome é obrigatório.'); end if;
  if v_role not in ('admin','gerente','operador') then perform _err('Papel inválido.'); end if;
  if v_pin is not null and v_pin !~ '^\d{4}$' then perform _err('PIN deve ter 4 dígitos.'); end if;
  if p_id = u.id and (not v_active or v_role <> 'admin') then perform _err('Você não pode tirar o próprio acesso de admin.'); end if;
  update users set name = trim(p_data->>'name'), role = v_role, active = v_active where id = p_id returning id into v_id;
  if v_id is null then perform _err('Usuário não encontrado.', 'NAO_ENCONTRADO'); end if;
  if not v_active then delete from op_sessions where user_id = v_id; end if;
  if v_pin is not null then
    insert into user_pins(user_id, pin_hash) values (v_id, crypt(v_pin, gen_salt('bf', 8)))
    on conflict (user_id) do update set pin_hash = excluded.pin_hash;
  end if;
  perform _audit(u.id, 'USUARIO_ALTERADO', 'user', v_id, jsonb_build_object('name', p_data->>'name', 'role', v_role, 'active', v_active, 'pin_changed', v_pin is not null));
  return jsonb_build_object('id', v_id);
end $$;

-- ---------- fornecedores e compras ----------
create or replace function supplier_save(p_token text, p_id int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; v_id int;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  if trim(coalesce(p_data->>'name', '')) = '' then perform _err('Nome do fornecedor é obrigatório.'); end if;
  if p_id is null then
    insert into suppliers(name, phone, doc, note, active) values (trim(p_data->>'name'), coalesce(p_data->>'phone', ''), coalesce(p_data->>'doc', ''),
      coalesce(p_data->>'note', ''), coalesce((p_data->>'active')::boolean, true)) returning id into v_id;
  else
    update suppliers set name = trim(p_data->>'name'), phone = coalesce(p_data->>'phone', phone), doc = coalesce(p_data->>'doc', doc),
      note = coalesce(p_data->>'note', note), active = coalesce((p_data->>'active')::boolean, active) where id = p_id returning id into v_id;
    if v_id is null then perform _err('Fornecedor não encontrado.', 'NAO_ENCONTRADO'); end if;
  end if;
  perform _audit(u.id, case when p_id is null then 'FORNECEDOR_CRIADO' else 'FORNECEDOR_ALTERADO' end, 'supplier', v_id, p_data);
  return (select to_jsonb(s) from suppliers s where id = v_id);
end $$;

-- Entrada de compra com vários itens de um fornecedor (tudo ou nada)
create or replace function purchase_entry(p_token text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; it jsonb; p products; v_pid int; v_sup int := nullif(p_data->>'supplier_id', '')::int; v_qty int; v_cost int;
  v_lot int; v_exp date; v_code text; v_total int := 0; v_n int := 0; v_bal int; v_supname text;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  if jsonb_typeof(p_data->'items') <> 'array' or jsonb_array_length(p_data->'items') = 0 then perform _err('Inclua pelo menos um item na compra.'); end if;
  if v_sup is not null then
    select name into v_supname from suppliers where id = v_sup and active;
    if v_supname is null then perform _err('Fornecedor não encontrado ou inativo.', 'NAO_ENCONTRADO'); end if;
  end if;
  insert into purchases(supplier_id, user_id, note) values (v_sup, u.id, nullif(p_data->>'note', '')) returning id into v_pid;
  for it in select * from jsonb_array_elements(p_data->'items') loop
    select * into p from products where id = (it->>'product_id')::int;
    if p.id is null then perform _err('Produto não encontrado.', 'NAO_ENCONTRADO'); end if;
    v_qty := (it->>'qty')::int;
    if v_qty is null or v_qty <= 0 then perform _err('Quantidade inválida em ' || p.name || '.'); end if;
    v_cost := nullif(it->>'unit_cost_cents', '')::int;
    if v_cost is not null and v_cost < 0 then perform _err('Custo inválido em ' || p.name || '.'); end if;
    v_exp := nullif(it->>'expiry_date', '')::date; v_code := nullif(it->>'lot_code', ''); v_lot := null;
    if v_code is not null or v_exp is not null then
      insert into lots(product_id, lot_code, expiry_date, qty_initial, qty_left) values (p.id, v_code, v_exp, v_qty, v_qty) returning id into v_lot;
    end if;
    if v_cost is not null then update products set cost_cents = v_cost, updated_at = now() where id = p.id; end if;
    v_bal := _apply_stock(p.id, v_qty, 'ENTRADA', u.id, coalesce(v_cost, p.cost_cents), 'compra', v_pid, v_lot,
      'Compra nº ' || v_pid || coalesce(' — ' || v_supname, ''), false);
    update stock_movements set supplier_id = v_sup where id = (select max(id) from stock_movements where product_id = p.id);
    v_total := v_total + round(coalesce(v_cost, p.cost_cents)::numeric * v_qty / 1000.0)::int; v_n := v_n + 1;
  end loop;
  update purchases set total_cents = v_total, items_count = v_n where id = v_pid;
  perform _audit(u.id, 'COMPRA_ENTRADA', 'purchase', v_pid, jsonb_build_object('supplier', v_supname, 'items', v_n, 'total', v_total));
  return jsonb_build_object('id', v_pid, 'total_cents', v_total, 'items_count', v_n);
end $$;

-- Preço do dia: altera vários preços de uma vez (gerente/admin), com auditoria de antes/depois
create or replace function prices_update(p_token text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; it jsonb; v_old int; v_new int; v_n int := 0; v_log jsonb := '[]'::jsonb; v_name text;
begin
  u := _op(p_token);
  perform _require_role(u, array['admin','gerente']);
  if jsonb_typeof(p_items) <> 'array' then perform _err('Lista de preços inválida.'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_new := (it->>'price_cents')::int;
    if v_new is null or v_new < 0 then perform _err('Preço inválido.'); end if;
    select price_cents, name into v_old, v_name from products where id = (it->>'id')::int for update;
    if v_old is null then perform _err('Produto não encontrado.', 'NAO_ENCONTRADO'); end if;
    if v_old <> v_new then
      update products set price_cents = v_new, updated_at = now() where id = (it->>'id')::int;
      v_n := v_n + 1; v_log := v_log || jsonb_build_object('produto', v_name, 'de', v_old, 'para', v_new);
    end if;
  end loop;
  if v_n > 0 then perform _audit(u.id, 'PRECOS_DO_DIA', 'products', null, jsonb_build_object('alterados', v_n, 'itens', v_log)); end if;
  return jsonb_build_object('changed', v_n);
end $$;

create or replace view v_purchases with (security_invoker = true) as
  select pu.*, _local_date(pu.created_at) as local_date, s.name as supplier_name, u.name as user_name
    from purchases pu left join suppliers s on s.id = pu.supplier_id join users u on u.id = pu.user_id;

-- A Edge Function confere se quem chama é admin antes de criar o login no Auth
create or replace function account_check_admin(p_token text, p_caller uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a users;
begin
  a := _admin_from_token(p_token, p_caller);
  return jsonb_build_object('id', a.id, 'name', a.name);
end $$;
