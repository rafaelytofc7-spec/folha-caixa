-- Dados de exemplo "Banca Folha". reset_seed() APAGA tudo (menos as contas da loja) e recria.
-- Não é exposta pela API: só roda pelo SQL do painel/Management API.
create or replace function reset_seed() returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  truncate audit_log, fiscal_documents, customer_ledger, held_sales, sale_payments, sale_items, sales, cash_movements,
    cash_session_counts, cash_sessions, customers, losses, stock_movements, lots, products, categories, op_sessions, user_pins, users,
    store_settings restart identity cascade;
  insert into store_settings(id, name, legal_name, cnpj, address, phone, receipt_footer)
  values (1, 'Banca Folha', 'Banca Folha Hortifruti', '00.000.000/0001-00', 'Rua da Feira, 100 — Box 12 — Centro', '(11) 90000-0000',
    'Obrigado pela preferência! Fruta boa é na Banca Folha.');
  insert into users(name, role) values ('Admin', 'admin'), ('Dona Cida', 'gerente'), ('Zé do Caixa', 'operador');
  insert into user_pins(user_id, pin_hash) values
    (1, crypt('1234', gen_salt('bf', 8))), (2, crypt('2580', gen_salt('bf', 8))), (3, crypt('1111', gen_salt('bf', 8)));
  insert into categories(name, slug, color, icon) values
    ('Frutas','frutas','#E8A33D','🍎'), ('Verduras','verduras','#3F9A4E','🥬'), ('Legumes','legumes','#D4742C','🥕'),
    ('Temperos','temperos','#7FA83A','🌿'), ('Ovos','ovos','#C9A46A','🥚'), ('Grãos','graos','#9A7349','🫘'),
    ('Frios','frios','#5E8FB8','🧀'), ('Padaria','padaria','#B9854A','🥖'), ('Bebidas','bebidas','#3F8FA0','🥤'),
    ('Outros','outros','#8A8178','🧺');
  insert into products(code, ean, name, category_id, unit, price_cents, cost_cents, stock_qty, min_stock, shortcut_pos, icon, ncm, cfop, cst)
  select v.code, v.ean, v.name, c.id, v.unit, v.price, v.cost, v.stock, v.mn, v.pos, v.icon, v.ncm, '5102', '102'
  from (values
    ('101', null, 'Tomate', 'legumes', 'KG', 699, 405, 40000, 3000, 1, '🍅', '07099990'),
    ('102', null, 'Tomate italiano', 'legumes', 'KG', 899, 521, 25000, 3000, null, '🍅', '07099990'),
    ('103', null, 'Cebola', 'legumes', 'KG', 549, 318, 50000, 3000, 4, '🧅', '07099990'),
    ('104', null, 'Batata', 'legumes', 'KG', 599, 347, 60000, 3000, 5, '🥔', '07099990'),
    ('105', null, 'Cenoura', 'legumes', 'KG', 479, 278, 30000, 3000, 6, '🥕', '07099990'),
    ('106', null, 'Abobrinha', 'legumes', 'KG', 599, 347, 15000, 3000, null, '🥒', '07099990'),
    ('107', null, 'Pepino', 'legumes', 'KG', 499, 289, 15000, 3000, null, '🥒', '07099990'),
    ('108', null, 'Pimentão verde', 'legumes', 'KG', 899, 521, 10000, 3000, null, '🫑', '07099990'),
    ('109', null, 'Berinjela', 'legumes', 'KG', 649, 376, 10000, 3000, null, '🍆', '07099990'),
    ('110', null, 'Chuchu', 'legumes', 'KG', 399, 231, 12000, 3000, null, '🥒', '07099990'),
    ('111', null, 'Batata-doce', 'legumes', 'KG', 549, 318, 20000, 3000, null, '🍠', '07099990'),
    ('112', null, 'Mandioca', 'legumes', 'KG', 699, 405, 20000, 3000, null, '🥔', '07099990'),
    ('113', null, 'Beterraba', 'legumes', 'KG', 499, 289, 15000, 3000, null, '🟣', '07099990'),
    ('114', null, 'Abóbora cabotiá', 'legumes', 'KG', 449, 260, 20000, 3000, null, '🎃', '07099990'),
    ('115', null, 'Alho', 'temperos', 'KG', 3299, 1913, 5000, 3000, null, '🧄', null),
    ('116', null, 'Gengibre', 'temperos', 'KG', 2490, 1444, 3000, 3000, null, '🫚', null),
    ('117', null, 'Repolho', 'verduras', 'KG', 399, 231, 20000, 3000, null, '🥬', '07099990'),
    ('118', null, 'Brócolis', 'verduras', 'KG', 1290, 748, 8000, 3000, null, '🥦', '07099990'),
    ('119', null, 'Couve-flor', 'verduras', 'KG', 990, 574, 8000, 3000, null, '🥦', '07099990'),
    ('201', null, 'Banana prata', 'frutas', 'KG', 649, 376, 40000, 3000, 2, '🍌', '07099990'),
    ('202', null, 'Banana nanica', 'frutas', 'KG', 499, 289, 30000, 3000, null, '🍌', '07099990'),
    ('203', null, 'Maçã gala', 'frutas', 'KG', 999, 579, 25000, 3000, 8, '🍎', '07099990'),
    ('204', null, 'Laranja pera', 'frutas', 'KG', 399, 231, 50000, 3000, 7, '🍊', '07099990'),
    ('205', null, 'Limão taiti', 'frutas', 'KG', 599, 347, 20000, 3000, null, '🍋', '07099990'),
    ('206', null, 'Mamão formosa', 'frutas', 'KG', 699, 405, 20000, 3000, null, '🥭', '07099990'),
    ('207', null, 'Manga palmer', 'frutas', 'KG', 799, 463, 15000, 3000, null, '🥭', '07099990'),
    ('208', null, 'Abacaxi', 'frutas', 'KG', 599, 347, 20000, 3000, null, '🍍', '07099990'),
    ('209', null, 'Melancia', 'frutas', 'KG', 349, 202, 60000, 3000, null, '🍉', '07099990'),
    ('210', null, 'Uva niágara', 'frutas', 'KG', 1499, 869, 8000, 3000, null, '🍇', '07099990'),
    ('211', null, 'Pera', 'frutas', 'KG', 1290, 748, 10000, 3000, null, '🍐', '07099990'),
    ('301', null, 'Alface crespa', 'verduras', 'MACO', 350, 203, 40000, 5000, 3, '🥬', '07099990'),
    ('302', null, 'Cheiro-verde', 'temperos', 'MACO', 300, 174, 30000, 5000, null, '🌿', null),
    ('303', null, 'Couve manteiga', 'verduras', 'MACO', 400, 232, 25000, 5000, null, '🥬', '07099990'),
    ('304', null, 'Morango', 'frutas', 'BANDEJA', 990, 574, 20000, 5000, null, '🍓', '07099990'),
    ('401', '7891000004012', 'Ovos brancos', 'ovos', 'DUZIA', 1190, 690, 30000, 5000, null, '🥚', null),
    ('501', '7891000005019', 'Feijão carioca 1 kg', 'graos', 'PCT', 899, 521, 20000, 5000, null, '🫘', null),
    ('601', null, 'Queijo minas frescal', 'frios', 'KG', 4290, 2488, 5000, 3000, null, '🧀', null),
    ('701', null, 'Pão francês', 'padaria', 'KG', 1699, 985, 8000, 3000, null, '🥖', null),
    ('801', '7891000008010', 'Água mineral 500 ml', 'bebidas', 'UN', 300, 174, 48000, 5000, null, '💧', null),
    ('901', '7891000009017', 'Sacola retornável', 'outros', 'UN', 500, 290, 50000, 5000, null, '🛍️', null)
  ) as v(code, ean, name, cat, unit, price, cost, stock, mn, pos, icon, ncm) join categories c on c.slug = v.cat
  order by v.code;
  insert into stock_movements(product_id, type, qty, balance_after, unit_cost_cents, note)
  select id, 'INICIAL', stock_qty, stock_qty, cost_cents, 'Estoque inicial (seed)' from products order by id;
  insert into lots(product_id, lot_code, expiry_date, qty_initial, qty_left)
  select id, l.lot, _today() + l.days, l.q, l.q from products p
  join (values ('304', 'L-MOR-01', 1, 20000), ('601', 'L-QMF-07', 2, 5000), ('401', 'L-OVO-33', 12, 30000)) l(code, lot, days, q) on l.code = p.code;
  insert into customers(name, phone, credit_limit_cents, note) values ('Dona Marta', '(11) 98888-1234', 30000, 'Cliente antiga, paga toda sexta.');
  insert into audit_log(action, entity, details) values ('SEED', 'sistema', '{"loja":"Banca Folha"}');
  return 'ok';
end $$;
