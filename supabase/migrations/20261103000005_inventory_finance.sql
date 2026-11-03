-- =====================================================================
-- Fase 4: Estoque, compras, fornecedores, financeiro, caixa, comissões
-- e relatórios. Saldos só mudam por movimento; operações idempotentes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Produtos / peças
-- ---------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  sku text not null,                       -- código interno
  manufacturer_code text,
  barcode text,
  name text not null,
  category text,
  unit text not null default 'un' check (unit in ('un','l','ml','kg','g','m','cj','par')),
  qty_decimals int not null default 0 check (qty_decimals between 0 and 3),
  location text,
  min_stock numeric(14,3) not null default 0,
  sale_price_cents bigint not null default 0 check (sale_price_cents >= 0),
  archived_at timestamptz,
  search text generated always as (private.norm_text(name || ' ' || sku || ' ' || coalesce(manufacturer_code,'') || ' ' || coalesce(barcode,''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  unique (workshop_id, sku)
);
create index products_search_trgm on public.products using gin (search extensions.gin_trgm_ops);
create trigger trg_products_touch before update on public.products for each row execute function private.touch_updated_at();
create trigger trg_audit_products after insert or update on public.products for each row execute function private.audit_row();

-- Custos separados (visíveis só com costs.view)
create table public.product_costs (
  product_id uuid primary key,
  workshop_id uuid not null,
  avg_cost_cents bigint not null default 0,
  last_cost_cents bigint not null default 0,
  updated_at timestamptz not null default now(),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);

create table public.stock_balances (
  product_id uuid primary key,
  workshop_id uuid not null,
  on_hand numeric(14,3) not null default 0,
  reserved numeric(14,3) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);

create or replace function private.product_init()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.stock_balances(product_id, workshop_id) values (new.id, new.workshop_id) on conflict do nothing;
  insert into public.product_costs(product_id, workshop_id) values (new.id, new.workshop_id) on conflict do nothing;
  return new;
end $$;
create trigger trg_product_init after insert on public.products for each row execute function private.product_init();

-- Saldo direto é proibido: só funções de movimento alteram
create or replace function private.block_direct_balance()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.stock_tx', true), '') <> 'on' then
    raise exception 'Saldo de estoque só pode ser alterado por movimentação';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger trg_block_direct_balance before update on public.stock_balances
  for each row execute function private.block_direct_balance();

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  product_id uuid not null,
  kind text not null check (kind in ('purchase_receipt','adjustment_in','adjustment_out','return_in','consumption',
                                     'sale','loss','reversal','inventory')),
  quantity numeric(14,3) not null check (quantity <> 0),   -- positivo entra, negativo sai
  unit_cost_cents bigint not null default 0,
  balance_after numeric(14,3) not null,
  order_id uuid,
  item_id uuid,
  receipt_item_id uuid,
  reverses_id uuid references public.stock_movements(id),
  reason text,
  negative_override_reason text,
  idempotency_key text unique,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);
create index on public.stock_movements(product_id, created_at desc);
create unique index one_reversal_per_movement on public.stock_movements(reverses_id) where reverses_id is not null;

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  item_id uuid not null,
  product_id uuid not null,
  quantity numeric(14,3) not null check (quantity > 0),
  status text not null default 'reserved' check (status in ('reserved','consumed','released','returned')),
  consumed_movement_id uuid references public.stock_movements(id),
  returned_movement_id uuid references public.stock_movements(id),
  released_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, item_id) references public.order_items(workshop_id, id),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);
create unique index one_active_reservation_per_item on public.stock_reservations(item_id) where status in ('reserved','consumed');

-- Núcleo: aplica movimento com trava de linha e regra de saldo negativo
create or replace function private.apply_stock_movement(p_product uuid, p_kind text, p_qty numeric, p_unit_cost bigint,
   p_reason text, p_idem text, p_order uuid default null, p_item uuid default null, p_receipt_item uuid default null,
   p_reverses uuid default null, p_negative_reason text default null, p_reserved_delta numeric default 0)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.stock_balances; pc public.product_costs; v_id uuid; v_new numeric; v_avg bigint; v_dec int;
begin
  if p_idem is not null then
    select id into v_id from public.stock_movements where idempotency_key = p_idem;
    if v_id is not null then return v_id; end if;           -- idempotente
  end if;
  select qty_decimals into v_dec from public.products where id = p_product;
  if round(p_qty, v_dec) <> p_qty then raise exception 'Quantidade com mais casas decimais que o permitido (%)', v_dec; end if;
  select * into b from public.stock_balances where product_id = p_product for update;
  select * into pc from public.product_costs where product_id = p_product for update;
  v_new := b.on_hand + p_qty;
  if v_new < 0 then
    if not private.has_perm(b.workshop_id, 'inventory.negative') or coalesce(trim(p_negative_reason),'') = '' then
      raise exception 'Estoque insuficiente (saldo % ). Saldo negativo exige permissão e justificativa.', b.on_hand
        using errcode = 'P0011';
    end if;
  end if;
  -- custo médio ponderado móvel: só entradas por compra alteram
  if p_kind = 'purchase_receipt' and p_qty > 0 then
    v_avg := case when b.on_hand <= 0 then p_unit_cost
                  else round((b.on_hand * pc.avg_cost_cents + p_qty * p_unit_cost) / (b.on_hand + p_qty)) end;
    update public.product_costs set avg_cost_cents = v_avg, last_cost_cents = p_unit_cost, updated_at = now() where product_id = p_product;
  end if;
  perform set_config('app.stock_tx', 'on', true);
  update public.stock_balances set on_hand = v_new, reserved = reserved + p_reserved_delta where product_id = p_product;
  perform set_config('app.stock_tx', 'off', true);
  insert into public.stock_movements(workshop_id, product_id, kind, quantity, unit_cost_cents, balance_after, order_id, item_id,
     receipt_item_id, reverses_id, reason, negative_override_reason, idempotency_key)
  values (b.workshop_id, p_product, p_kind, p_qty, coalesce(p_unit_cost, pc.avg_cost_cents), v_new, p_order, p_item,
     p_receipt_item, p_reverses, p_reason, p_negative_reason, p_idem)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reserve_part(p_item uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.order_items; b public.stock_balances; v uuid;
begin
  select * into i from public.order_items where id = p_item for update;
  perform private.require_perm(i.workshop_id, 'inventory.edit');
  if i.kind <> 'part' or i.product_id is null or i.part_origin <> 'stock' then
    raise exception 'Somente peças do estoque podem ser reservadas';
  end if;
  if i.status not in ('approved','in_progress','pending_approval') then raise exception 'Item não está ativo'; end if;
  select id into v from public.stock_reservations where item_id = p_item and status in ('reserved','consumed');
  if v is not null then return v; end if;
  select * into b from public.stock_balances where product_id = i.product_id for update;
  if b.on_hand - b.reserved < i.quantity then
    raise exception 'Disponível insuficiente: % (físico % − reservado %)', b.on_hand - b.reserved, b.on_hand, b.reserved
      using errcode = 'P0011';
  end if;
  perform set_config('app.stock_tx', 'on', true);
  update public.stock_balances set reserved = reserved + i.quantity where product_id = i.product_id;
  perform set_config('app.stock_tx', 'off', true);
  insert into public.stock_reservations(workshop_id, order_id, item_id, product_id, quantity)
  values (i.workshop_id, i.order_id, p_item, i.product_id, i.quantity) returning id into v;
  return v;
end $$;

create or replace function public.release_reservation(p_reservation uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.stock_reservations;
begin
  select * into r from public.stock_reservations where id = p_reservation for update;
  perform private.require_perm(r.workshop_id, 'inventory.edit');
  if r.status <> 'reserved' then return; end if;
  perform 1 from public.stock_balances where product_id = r.product_id for update;
  perform set_config('app.stock_tx', 'on', true);
  update public.stock_balances set reserved = reserved - r.quantity where product_id = r.product_id;
  perform set_config('app.stock_tx', 'off', true);
  update public.stock_reservations set status = 'released', released_at = now() where id = p_reservation;
end $$;

-- Libera reservas ativas de uma OS ou de um item, devolvendo o saldo reservado
create or replace function private.release_reservations(p_order uuid, p_item uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select * from public.stock_reservations
            where status = 'reserved' and (order_id = p_order or item_id = p_item)
            order by product_id for update loop
    perform 1 from public.stock_balances where product_id = r.product_id for update;
    perform set_config('app.stock_tx', 'on', true);
    update public.stock_balances set reserved = reserved - r.quantity where product_id = r.product_id;
    perform set_config('app.stock_tx', 'off', true);
    update public.stock_reservations set status = 'released', released_at = now() where id = r.id;
  end loop;
end $$;

-- Consumo: exatamente uma vez (status + chave idempotente)
create or replace function public.consume_reservation(p_reservation uuid, p_negative_reason text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.stock_reservations; v_mov uuid; v_cost bigint; o public.service_orders;
begin
  select * into r from public.stock_reservations where id = p_reservation for update;
  if r.id is null then raise exception 'Reserva não encontrada'; end if;
  if not (private.has_perm(r.workshop_id, 'inventory.edit') or
          (private.has_perm(r.workshop_id, 'orders.execute') and private.can_see_order(r.order_id))) then
    raise exception 'Sem permissão para consumir peça' using errcode = '42501';
  end if;
  if r.status = 'consumed' then return r.consumed_movement_id; end if;
  if r.status <> 'reserved' then raise exception 'Reserva não está ativa'; end if;
  select * into o from public.service_orders where id = r.order_id;
  if o.status in ('delivered','cancelled') then raise exception 'OS encerrada'; end if;
  v_mov := private.apply_stock_movement(r.product_id, 'consumption', -r.quantity, null, 'Consumo OS ' || o.number,
             'consume:' || r.id, r.order_id, r.item_id, null, null, p_negative_reason, -r.quantity);
  select unit_cost_cents into v_cost from public.stock_movements where id = v_mov;
  update public.stock_reservations set status = 'consumed', consumed_movement_id = v_mov where id = p_reservation;
  -- salva custo aplicado (preserva margem histórica)
  insert into public.order_item_costs(item_id, workshop_id, unit_cost_cents, total_cost_cents, cost_source)
  values (r.item_id, r.workshop_id, v_cost, round(r.quantity * v_cost), 'stock_avg')
  on conflict (item_id) do update set unit_cost_cents = excluded.unit_cost_cents, total_cost_cents = excluded.total_cost_cents,
     cost_source = 'stock_avg', updated_at = now();
  return v_mov;
end $$;

-- Devolução ao estoque (estorno do consumo) — uma única vez
create or replace function public.return_consumed(p_reservation uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.stock_reservations; m public.stock_movements; v uuid;
begin
  select * into r from public.stock_reservations where id = p_reservation for update;
  perform private.require_perm(r.workshop_id, 'inventory.edit');
  if r.status = 'returned' then return r.returned_movement_id; end if;
  if r.status <> 'consumed' then raise exception 'Somente peça consumida pode ser devolvida'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo da devolução'; end if;
  select * into m from public.stock_movements where id = r.consumed_movement_id;
  v := private.apply_stock_movement(r.product_id, 'return_in', r.quantity, m.unit_cost_cents, p_reason,
         'return:' || r.id, r.order_id, r.item_id, null, m.id);
  update public.stock_reservations set status = 'returned', returned_movement_id = v where id = p_reservation;
  return v;
end $$;

create or replace function public.adjust_stock(p_product uuid, p_qty_delta numeric, p_kind text, p_reason text,
   p_idem text, p_unit_cost bigint default null, p_negative_reason text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.products where id = p_product;
  perform private.require_perm(v_ws, 'inventory.adjust');
  if p_kind not in ('adjustment_in','adjustment_out','loss','sale') then raise exception 'Tipo de ajuste inválido'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo do ajuste'; end if;
  if (p_kind = 'adjustment_in' and p_qty_delta <= 0) or (p_kind <> 'adjustment_in' and p_qty_delta >= 0) then
    raise exception 'Sinal da quantidade incompatível com o tipo';
  end if;
  return private.apply_stock_movement(p_product, p_kind, p_qty_delta, p_unit_cost, p_reason, p_idem,
                                      null, null, null, null, p_negative_reason);
end $$;

-- Inventário com contagem e divergências
create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (workshop_id, id)
);
create table public.inventory_count_items (
  count_id uuid not null,
  workshop_id uuid not null,
  product_id uuid not null,
  expected numeric(14,3) not null,
  counted numeric(14,3),
  primary key (count_id, product_id),
  foreign key (workshop_id, count_id) references public.inventory_counts(workshop_id, id),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);

create or replace function public.close_inventory(p_count uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.inventory_counts; r record; n int := 0; cur numeric;
begin
  select * into c from public.inventory_counts where id = p_count for update;
  perform private.require_perm(c.workshop_id, 'inventory.adjust');
  if c.status <> 'open' then raise exception 'Inventário já encerrado'; end if;
  for r in select * from public.inventory_count_items where count_id = p_count and counted is not null loop
    select on_hand into cur from public.stock_balances where product_id = r.product_id;
    if r.counted <> cur then
      perform private.apply_stock_movement(r.product_id, 'inventory', r.counted - cur, null,
         'Inventário ' || left(p_count::text, 8) || ' (esperado ' || r.expected || ', contado ' || r.counted || ')',
         'inv:' || p_count || ':' || r.product_id, null, null, null, null,
         case when r.counted < 0 then 'inventário' end);
      n := n + 1;
    end if;
  end loop;
  update public.inventory_counts set status = 'closed', closed_at = now() where id = p_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Fornecedores e compras
-- ---------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  name text not null,
  document text,
  phone text,
  email text,
  contacts jsonb not null default '[]'::jsonb,
  payment_terms text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workshop_id, id)
);
alter table public.order_items add constraint oi_supplier_fk foreign key (workshop_id, supplier_id) references public.suppliers(workshop_id, id);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  number text not null,
  supplier_id uuid not null,
  order_id uuid,                     -- compra direta para OS
  status text not null default 'draft' check (status in ('draft','sent','partial','received','cancelled')),
  expected_on date,
  notes text,
  cancel_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (workshop_id, id),
  unique (workshop_id, number),
  foreign key (workshop_id, supplier_id) references public.suppliers(workshop_id, id),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  purchase_id uuid not null,
  product_id uuid,
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  received_qty numeric(14,3) not null default 0,
  unique (workshop_id, id),
  foreign key (workshop_id, purchase_id) references public.purchase_orders(workshop_id, id),
  foreign key (workshop_id, product_id) references public.products(workshop_id, id)
);
create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  purchase_id uuid not null,
  received_on date not null default current_date,
  invoice_ref text,
  idempotency_key text unique,
  payable_account_id uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (workshop_id, id),
  foreign key (workshop_id, purchase_id) references public.purchase_orders(workshop_id, id)
);
create table public.purchase_receipt_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  receipt_id uuid not null,
  po_item_id uuid not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost_cents bigint not null,
  foreign key (workshop_id, receipt_id) references public.purchase_receipts(workshop_id, id),
  foreign key (workshop_id, po_item_id) references public.purchase_order_items(workshop_id, id)
);

create or replace function public.save_purchase(p_workshop uuid, p_supplier uuid, p_items jsonb, p_expected date,
                                               p_notes text, p_order uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid; e jsonb;
begin
  perform private.require_perm(p_workshop, 'purchasing.edit');
  insert into public.purchase_orders(workshop_id, number, supplier_id, order_id, expected_on, notes, status)
  values (p_workshop, private.next_number(p_workshop, 'purchase'), p_supplier, p_order, p_expected, p_notes, 'sent')
  returning id into v;
  for e in select * from jsonb_array_elements(p_items) loop
    insert into public.purchase_order_items(workshop_id, purchase_id, product_id, description, quantity, unit_cost_cents)
    values (p_workshop, v, nullif(e->>'product_id','')::uuid, e->>'description', (e->>'quantity')::numeric,
            (e->>'unit_cost_cents')::bigint);
  end loop;
  return v;
end $$;

-- Recebimento (parcial ou total): entrada no estoque + conta a pagar
create or replace function public.receive_purchase(p_purchase uuid, p_items jsonb, p_invoice text, p_due_date date,
                                                  p_idem text, p_installments int default 1)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare po public.purchase_orders; v_rec uuid; e jsonb; it public.purchase_order_items; v_total bigint := 0; v_ri uuid;
        v_acc uuid; k int; v_part bigint;
begin
  select * into po from public.purchase_orders where id = p_purchase for update;
  perform private.require_perm(po.workshop_id, 'purchasing.receive');
  select id into v_rec from public.purchase_receipts where idempotency_key = p_idem;
  if v_rec is not null then return v_rec; end if;
  if po.status in ('received','cancelled') then raise exception 'Pedido já recebido ou cancelado'; end if;
  insert into public.purchase_receipts(workshop_id, purchase_id, invoice_ref, idempotency_key)
  values (po.workshop_id, p_purchase, p_invoice, p_idem) returning id into v_rec;
  for e in select * from jsonb_array_elements(p_items) loop
    select * into it from public.purchase_order_items where id = (e->>'po_item_id')::uuid and purchase_id = p_purchase for update;
    if it.id is null then raise exception 'Item inválido'; end if;
    if (e->>'quantity')::numeric <= 0 then continue; end if;
    if it.received_qty + (e->>'quantity')::numeric > it.quantity then
      raise exception 'Quantidade recebida maior que a pedida em "%"', it.description;
    end if;
    insert into public.purchase_receipt_items(workshop_id, receipt_id, po_item_id, quantity, unit_cost_cents)
    values (po.workshop_id, v_rec, it.id, (e->>'quantity')::numeric, coalesce((e->>'unit_cost_cents')::bigint, it.unit_cost_cents))
    returning id into v_ri;
    update public.purchase_order_items set received_qty = received_qty + (e->>'quantity')::numeric where id = it.id;
    if it.product_id is not null and po.order_id is null then
      perform private.apply_stock_movement(it.product_id, 'purchase_receipt', (e->>'quantity')::numeric,
        coalesce((e->>'unit_cost_cents')::bigint, it.unit_cost_cents), 'Recebimento ' || po.number, 'rcv:' || v_ri,
        null, null, v_ri);
    end if;
    v_total := v_total + round((e->>'quantity')::numeric * coalesce((e->>'unit_cost_cents')::bigint, it.unit_cost_cents));
  end loop;
  update public.purchase_orders set status = case when exists (select 1 from public.purchase_order_items where purchase_id = p_purchase
      and received_qty < quantity) then 'partial' else 'received' end where id = p_purchase;
  if v_total > 0 then
    insert into public.accounts(workshop_id, kind, supplier_id, category, description, total_cents, competence_date, purchase_receipt_id)
    values (po.workshop_id, 'payable', po.supplier_id, 'compras', 'Compra ' || po.number || coalesce(' NF ' || p_invoice, ''),
            v_total, current_date, v_rec) returning id into v_acc;
    for k in 1..greatest(p_installments,1) loop
      v_part := case when k = greatest(p_installments,1) then v_total - (v_total / greatest(p_installments,1)) * (greatest(p_installments,1) - 1)
                     else v_total / greatest(p_installments,1) end;
      insert into public.account_installments(workshop_id, account_id, seq, due_date, amount_cents)
      values (po.workshop_id, v_acc, k, coalesce(p_due_date, current_date) + ((k-1) * 30), v_part);
    end loop;
    update public.purchase_receipts set payable_account_id = v_acc where id = v_rec;
  end if;
  return v_rec;
end $$;

create or replace function public.cancel_purchase(p_purchase uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_purchase for update;
  perform private.require_perm(po.workshop_id, 'purchasing.edit');
  if po.status in ('received','cancelled') then raise exception 'Pedido já encerrado'; end if;
  -- recebimentos existentes são preservados
  update public.purchase_orders set status = 'cancelled', cancel_reason = p_reason where id = p_purchase;
end $$;

-- ---------------------------------------------------------------------
-- Financeiro
-- ---------------------------------------------------------------------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  kind text not null check (kind in ('receivable','payable')),
  order_id uuid,
  client_id uuid,
  supplier_id uuid,
  purchase_receipt_id uuid,
  category text not null default 'servicos',
  cost_type text check (cost_type in ('fixa','variavel')),
  description text not null,
  total_cents bigint not null check (total_cents > 0),
  competence_date date not null default current_date,
  status text not null default 'open' check (status in ('open','paid','cancelled')),
  cancel_reason text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (workshop_id, id),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, supplier_id) references public.suppliers(workshop_id, id)
);
create unique index one_receivable_per_order on public.accounts(order_id) where kind = 'receivable' and status <> 'cancelled' and order_id is not null;
create trigger trg_audit_accounts after insert or update on public.accounts for each row execute function private.audit_row();

create table public.account_installments (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  account_id uuid not null,
  seq int not null,
  due_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_cents bigint not null default 0,
  unique (account_id, seq),
  unique (workshop_id, id),
  foreign key (workshop_id, account_id) references public.accounts(workshop_id, id),
  check (paid_cents >= 0 and paid_cents <= amount_cents)
);
create index on public.account_installments(workshop_id, due_date);

create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  opened_by uuid default auth.uid(),
  opened_at timestamptz not null default now(),
  opening_cents bigint not null default 0,
  closed_at timestamptz,
  closed_by uuid,
  counted_cents bigint,
  expected_cents bigint,
  difference_cents bigint,
  notes text,
  unique (workshop_id, id)
);
create unique index one_open_cash on public.cash_sessions(workshop_id) where closed_at is null;

create table public.account_payments (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  installment_id uuid not null,
  amount_cents bigint not null check (amount_cents <> 0),     -- negativo = estorno
  method text not null,
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  paid_at timestamptz not null default now(),
  cash_session_id uuid,
  reference text,                 -- ex.: id da transação Pix informado manualmente
  attachment_path text,           -- comprovante privado
  notes text,
  receipt_number text,
  reconciled_at timestamptz,
  reconciled_by uuid,
  reverses_payment_id uuid references public.account_payments(id),
  reversed_at timestamptz,
  reversal_reason text,
  idempotency_key text not null unique,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, installment_id) references public.account_installments(workshop_id, id),
  foreign key (workshop_id, cash_session_id) references public.cash_sessions(workshop_id, id)
);
create unique index one_reversal_per_payment on public.account_payments(reverses_payment_id) where reverses_payment_id is not null;
create index on public.account_payments(workshop_id, paid_at);
create trigger trg_audit_payments after insert or update on public.account_payments for each row execute function private.audit_row();

-- Pagamentos não são editados nem apagados
create or replace function private.payment_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Pagamentos não podem ser excluídos; registre estorno'; end if;
  if new.amount_cents <> old.amount_cents or new.installment_id <> old.installment_id or new.method <> old.method then
    raise exception 'Pagamentos não podem ser alterados; registre estorno';
  end if;
  return new;
end $$;
create trigger trg_payment_immutable before update or delete on public.account_payments
  for each row execute function private.payment_immutable();

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  session_id uuid not null,
  kind text not null check (kind in ('entrada','saida','sangria','suprimento')),
  amount_cents bigint not null check (amount_cents > 0),
  description text not null,
  payment_id uuid references public.account_payments(id),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, session_id) references public.cash_sessions(workshop_id, id)
);

create or replace function private.refresh_account_status(p_account uuid)
returns void language sql as $$
  update public.accounts a set status = case
     when a.status = 'cancelled' then 'cancelled'
     when not exists (select 1 from public.account_installments i where i.account_id = a.id and i.paid_cents < i.amount_cents) then 'paid'
     else 'open' end
  where a.id = p_account
$$;

-- Cobrança da OS: total recalculado no servidor a partir dos itens executados
create or replace function public.create_order_receivable(p_order uuid, p_installments jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_total bigint; v_sum bigint; v uuid; e jsonb; k int := 0;
begin
  select * into o from public.service_orders where id = p_order for update;
  perform private.require_perm(o.workshop_id, 'finance.edit');
  select id into v from public.accounts where order_id = p_order and kind = 'receivable' and status <> 'cancelled';
  if v is not null then return v; end if;   -- idempotente
  select coalesce(sum(total_cents),0) into v_total from public.order_items
   where order_id = p_order and status in ('approved','in_progress','done');
  if v_total <= 0 then raise exception 'OS sem valor aprovado para cobrança'; end if;
  select coalesce(sum((x->>'amount_cents')::bigint),0) into v_sum from jsonb_array_elements(p_installments) x;
  if v_sum <> v_total then
    raise exception 'Soma das parcelas (%) difere do total da OS (%)', v_sum, v_total using errcode = 'P0012';
  end if;
  insert into public.accounts(workshop_id, kind, order_id, client_id, category, description, total_cents)
  values (o.workshop_id, 'receivable', p_order, o.client_id, 'servicos', 'OS ' || o.number, v_total) returning id into v;
  for e in select * from jsonb_array_elements(p_installments) loop
    k := k + 1;
    insert into public.account_installments(workshop_id, account_id, seq, due_date, amount_cents)
    values (o.workshop_id, v, k, (e->>'due_date')::date, (e->>'amount_cents')::bigint);
  end loop;
  return v;
end $$;

create or replace function public.create_account(p_workshop uuid, p_kind text, p_description text, p_category text,
   p_installments jsonb, p_client uuid default null, p_supplier uuid default null, p_cost_type text default null,
   p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid; v_total bigint; e jsonb; k int := 0;
begin
  perform private.require_perm(p_workshop, 'finance.edit');
  select sum((x->>'amount_cents')::bigint) into v_total from jsonb_array_elements(p_installments) x;
  insert into public.accounts(workshop_id, kind, client_id, supplier_id, category, cost_type, description, total_cents, notes)
  values (p_workshop, p_kind, p_client, p_supplier, p_category, p_cost_type, p_description, v_total, p_notes) returning id into v;
  for e in select * from jsonb_array_elements(p_installments) loop
    k := k + 1;
    insert into public.account_installments(workshop_id, account_id, seq, due_date, amount_cents)
    values (p_workshop, v, k, (e->>'due_date')::date, (e->>'amount_cents')::bigint);
  end loop;
  return v;
end $$;

create or replace function public.cancel_account(p_account uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id = p_account for update;
  perform private.require_perm(a.workshop_id, 'finance.edit');
  if exists (select 1 from public.account_installments where account_id = p_account and paid_cents > 0) then
    raise exception 'Conta com pagamentos: estorne-os antes de cancelar';
  end if;
  update public.accounts set status = 'cancelled', cancel_reason = p_reason where id = p_account;
end $$;

-- Recebimento/pagamento: idempotente, nunca acima do saldo
create or replace function public.register_payment(p_installment uuid, p_amount_cents bigint, p_method text, p_idem text,
   p_fee_cents bigint default 0, p_reference text default null, p_notes text default null, p_paid_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.account_installments; a public.accounts; v uuid; v_cash uuid; w public.workshops;
begin
  select id into v from public.account_payments where idempotency_key = p_idem;
  if v is not null then return v; end if;
  select * into i from public.account_installments where id = p_installment for update;
  select * into a from public.accounts where id = i.account_id for update;
  if a.kind = 'receivable' then perform private.require_perm(a.workshop_id, 'payments.receive');
  else perform private.require_perm(a.workshop_id, 'finance.edit'); end if;
  if a.status = 'cancelled' then raise exception 'Conta cancelada'; end if;
  if p_amount_cents <= 0 then raise exception 'Valor deve ser positivo'; end if;
  if p_amount_cents > i.amount_cents - i.paid_cents then
    raise exception 'Valor (%) maior que o saldo da parcela (%)', p_amount_cents, i.amount_cents - i.paid_cents using errcode = 'P0013';
  end if;
  select * into w from public.workshops where id = a.workshop_id;
  if not (w.payment_methods ? p_method) then raise exception 'Forma de pagamento não habilitada: %', p_method; end if;
  if p_method = 'dinheiro' then
    select id into v_cash from public.cash_sessions where workshop_id = a.workshop_id and closed_at is null;
    if v_cash is null then raise exception 'Abra o caixa para movimentar dinheiro'; end if;
  end if;
  insert into public.account_payments(workshop_id, installment_id, amount_cents, method, fee_cents, paid_at, cash_session_id,
     reference, notes, idempotency_key, receipt_number)
  values (a.workshop_id, p_installment, p_amount_cents, p_method, coalesce(p_fee_cents,0), coalesce(p_paid_at, now()), v_cash,
     p_reference, p_notes, p_idem, case when a.kind = 'receivable' then private.next_number(a.workshop_id, 'receipt') end)
  returning id into v;
  update public.account_installments set paid_cents = paid_cents + p_amount_cents where id = p_installment;
  if v_cash is not null then
    insert into public.cash_movements(workshop_id, session_id, kind, amount_cents, description, payment_id)
    values (a.workshop_id, v_cash, case when a.kind = 'receivable' then 'entrada' else 'saida' end, p_amount_cents, a.description, v);
  end if;
  perform private.refresh_account_status(a.id);
  if a.order_id is not null and (select status from public.accounts where id = a.id) = 'paid' then
    perform private.generate_commissions(a.order_id, 'recebimento');
  end if;
  return v;
end $$;

create or replace function public.reverse_payment(p_payment uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.account_payments; a public.accounts; v uuid; v_cash uuid;
begin
  select * into p from public.account_payments where id = p_payment for update;
  perform private.require_perm(p.workshop_id, 'payments.refund');
  if p.reverses_payment_id is not null then raise exception 'Não é possível estornar um estorno'; end if;
  if p.reversed_at is not null then
    select id into v from public.account_payments where reverses_payment_id = p_payment; return v;   -- idempotente
  end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo do estorno'; end if;
  select a2.* into a from public.accounts a2 join public.account_installments i on i.account_id = a2.id where i.id = p.installment_id;
  if p.method = 'dinheiro' then
    select id into v_cash from public.cash_sessions where workshop_id = p.workshop_id and closed_at is null;
    if v_cash is null then raise exception 'Abra o caixa para estornar em dinheiro'; end if;
  end if;
  insert into public.account_payments(workshop_id, installment_id, amount_cents, method, cash_session_id, reverses_payment_id,
     notes, idempotency_key)
  values (p.workshop_id, p.installment_id, -p.amount_cents, p.method, v_cash, p_payment, p_reason, 'rev:' || p_payment)
  returning id into v;
  update public.account_payments set reversed_at = now(), reversal_reason = p_reason where id = p_payment;
  update public.account_installments set paid_cents = paid_cents - p.amount_cents where id = p.installment_id;
  if v_cash is not null then
    insert into public.cash_movements(workshop_id, session_id, kind, amount_cents, description, payment_id)
    values (p.workshop_id, v_cash, case when a.kind = 'receivable' then 'saida' else 'entrada' end, p.amount_cents,
            'Estorno: ' || p_reason, v);
  end if;
  perform private.refresh_account_status(a.id);
  update public.commission_entries set status = 'reversed', reversed_reason = 'Pagamento estornado'
   where order_id = a.order_id and basis = 'recebimento' and status <> 'reversed';
  return v;
end $$;

create or replace function public.reconcile_payment(p_payment uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.account_payments;
begin
  select * into p from public.account_payments where id = p_payment;
  perform private.require_perm(p.workshop_id, 'finance.edit');
  update public.account_payments set reconciled_at = now(), reconciled_by = auth.uid() where id = p_payment and reconciled_at is null;
end $$;

create or replace function public.open_cash(p_workshop uuid, p_opening_cents bigint)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  perform private.require_perm(p_workshop, 'cash.operate');
  begin
    insert into public.cash_sessions(workshop_id, opening_cents) values (p_workshop, p_opening_cents) returning id into v;
  exception when unique_violation then raise exception 'Já existe um caixa aberto';
  end;
  return v;
end $$;

create or replace function public.cash_movement(p_workshop uuid, p_kind text, p_amount bigint, p_description text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_s uuid; v uuid;
begin
  perform private.require_perm(p_workshop, 'cash.operate');
  if p_kind not in ('sangria','suprimento','saida','entrada') then raise exception 'Tipo inválido'; end if;
  select id into v_s from public.cash_sessions where workshop_id = p_workshop and closed_at is null for update;
  if v_s is null then raise exception 'Nenhum caixa aberto'; end if;
  insert into public.cash_movements(workshop_id, session_id, kind, amount_cents, description)
  values (p_workshop, v_s, p_kind, p_amount, p_description) returning id into v;
  return v;
end $$;

create or replace function public.cash_expected(p_session uuid)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select s.opening_cents + coalesce(sum(case when m.kind in ('entrada','suprimento') then m.amount_cents else -m.amount_cents end), 0)
    from public.cash_sessions s left join public.cash_movements m on m.session_id = s.id
   where s.id = p_session group by s.opening_cents
$$;

create or replace function public.close_cash(p_workshop uuid, p_counted_cents bigint, p_notes text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.cash_sessions; v_exp bigint;
begin
  perform private.require_perm(p_workshop, 'cash.operate');
  select * into s from public.cash_sessions where workshop_id = p_workshop and closed_at is null for update;
  if s.id is null then raise exception 'Nenhum caixa aberto'; end if;
  v_exp := public.cash_expected(s.id);
  if p_counted_cents <> v_exp and coalesce(trim(p_notes),'') = '' then
    raise exception 'Diferença de caixa exige observação';
  end if;
  update public.cash_sessions set closed_at = now(), closed_by = auth.uid(), counted_cents = p_counted_cents,
     expected_cents = v_exp, difference_cents = p_counted_cents - v_exp, notes = p_notes where id = s.id;
  return jsonb_build_object('expected_cents', v_exp, 'counted_cents', p_counted_cents, 'difference_cents', p_counted_cents - v_exp);
end $$;

-- ---------------------------------------------------------------------
-- Comissões (opcionais; não é folha de pagamento)
-- ---------------------------------------------------------------------
create table public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  membership_id uuid not null,
  service_id uuid,                       -- nulo = todos os serviços
  kind text not null check (kind in ('percent','fixed')),
  value numeric(12,2) not null check (value >= 0),
  basis text not null check (basis in ('competencia','recebimento')),
  base_definition text not null default 'Valor líquido do item de serviço executado (após desconto)',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id)
);
create table public.commission_entries (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  membership_id uuid not null,
  rule_id uuid not null,
  order_id uuid not null,
  item_id uuid not null,
  basis text not null,
  base_cents bigint not null,
  amount_cents bigint not null,
  status text not null default 'pending' check (status in ('pending','approved','reversed')),
  approved_by uuid,
  approved_at timestamptz,
  reversed_reason text,
  created_at timestamptz not null default now(),
  foreign key (workshop_id, rule_id) references public.commission_rules(workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id)
);
create unique index one_commission_per_item_rule on public.commission_entries(item_id, rule_id) where status <> 'reversed';

create or replace function private.generate_commissions(p_order uuid, p_basis text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.commission_entries(workshop_id, membership_id, rule_id, order_id, item_id, basis, base_cents, amount_cents)
  select i.workshop_id, r.membership_id, r.id, p_order, i.id, r.basis, i.total_cents,
         case when r.kind = 'percent' then round(i.total_cents * r.value / 100) else round(r.value * 100) end
    from public.order_items i
    join public.commission_rules r on r.workshop_id = i.workshop_id and r.active and r.basis = p_basis
         and r.membership_id = i.assigned_membership_id and (r.service_id is null or r.service_id = i.service_id)
   where i.order_id = p_order and i.kind = 'service' and i.status = 'done'
     and (p_basis = 'recebimento' or exists (select 1 from public.service_orders o where o.id = p_order and o.status = 'delivered'))
  on conflict do nothing;
end $$;

create or replace function public.approve_commissions(p_ids uuid[])
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_ws uuid;
begin
  select workshop_id into v_ws from public.commission_entries where id = p_ids[1];
  perform private.require_perm(v_ws, 'commissions.manage');
  update public.commission_entries set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = any(p_ids) and workshop_id = v_ws and status = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Ajustes de referências a custos (custo separado de produtos)
-- ---------------------------------------------------------------------
create or replace function public.product_list(p_workshop uuid, p_q text default null, p_low_only boolean default false,
   p_limit int default 50, p_offset int default 0)
returns table(id uuid, sku text, name text, category text, unit text, qty_decimals int, location text, min_stock numeric,
              sale_price_cents bigint, on_hand numeric, reserved numeric, available numeric, avg_cost_cents bigint,
              manufacturer_code text, barcode text, low boolean, version int, total_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.sku, p.name, p.category, p.unit, p.qty_decimals, p.location, p.min_stock,
         case when private.has_perm(p_workshop,'prices.view') or private.has_perm(p_workshop,'inventory.view') then p.sale_price_cents end,
         b.on_hand, b.reserved, b.on_hand - b.reserved,
         case when private.has_perm(p_workshop,'costs.view') then c.avg_cost_cents end,
         p.manufacturer_code, p.barcode, (b.on_hand - b.reserved) <= p.min_stock, p.version, count(*) over ()
    from public.products p join public.stock_balances b on b.product_id = p.id join public.product_costs c on c.product_id = p.id
   where p.workshop_id = p_workshop and p.archived_at is null
     and (private.has_perm(p_workshop,'inventory.view') or private.has_perm(p_workshop,'quotes.create') or private.has_perm(p_workshop,'orders.edit'))
     and (p_q is null or p_q = '' or p.search like '%' || private.norm_text(p_q) || '%')
     and (not p_low_only or (b.on_hand - b.reserved) <= p.min_stock)
   order by p.name limit p_limit offset p_offset
$$;

-- ---------------------------------------------------------------------
-- Relatórios (respeitam permissões; períodos em datas locais)
-- ---------------------------------------------------------------------
create or replace function public.report_operations(p_workshop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; r jsonb;
begin
  perform private.require_perm(p_workshop, 'reports.view');
  select timezone into tz from public.workshops where id = p_workshop;
  select jsonb_build_object(
    'definicao', 'OS com entrada no período (data local). Atrasadas = previsão vencida e não pronta/entregue.',
    'orders_opened', count(*),
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.service_orders
                   where workshop_id = p_workshop and (entry_at at time zone tz)::date between p_from and p_to group by status) s),
    'delivered', count(*) filter (where status = 'delivered'),
    'cancelled', count(*) filter (where status = 'cancelled'),
    'late_now', (select count(*) from public.service_orders where workshop_id = p_workshop and expected_delivery_at < now()
                  and status not in ('ready','delivered','cancelled')),
    'avg_hours_entry_to_ready', round((avg(extract(epoch from (ready_at - entry_at))/3600) filter (where ready_at is not null))::numeric, 1),
    'stage_hours', (select coalesce(jsonb_object_agg(st, h), '{}'::jsonb) from (
        select h1.to_status st, round(avg(extract(epoch from (coalesce(h2.changed_at, now()) - h1.changed_at))/3600)::numeric, 1) h
          from public.order_status_history h1
          left join lateral (select changed_at from public.order_status_history h2 where h2.order_id = h1.order_id and h2.changed_at > h1.changed_at
                              order by changed_at limit 1) h2 on true
          join public.service_orders o on o.id = h1.order_id
         where o.workshop_id = p_workshop and (o.entry_at at time zone tz)::date between p_from and p_to
           and h1.to_status not in ('delivered','cancelled')
         group by h1.to_status) x),
    'top_services', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select i.description, count(*) n from public.order_items i
         join public.service_orders o on o.id = i.order_id where o.workshop_id = p_workshop and i.kind = 'service' and i.status = 'done'
          and (o.entry_at at time zone tz)::date between p_from and p_to group by i.description order by n desc limit 10) t),
    'top_parts', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select p.name, sum(-m.quantity) qty from public.stock_movements m
         join public.products p on p.id = m.product_id where m.workshop_id = p_workshop and m.kind = 'consumption'
          and (m.created_at at time zone tz)::date between p_from and p_to group by p.name order by qty desc limit 10) t)
  ) into r
  from public.service_orders where workshop_id = p_workshop and (entry_at at time zone tz)::date between p_from and p_to;
  return r;
end $$;

create or replace function public.report_quotes(p_workshop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; r jsonb;
begin
  perform private.require_perm(p_workshop, 'reports.view');
  select timezone into tz from public.workshops where id = p_workshop;
  select jsonb_build_object(
    'definicao', 'Versões de orçamento ENVIADAS no período. Conversão = (aprovados + parciais) ÷ (decididos). Expirados e substituídos não entram no denominador.',
    'sent', count(*),
    'approved', count(*) filter (where v.status = 'approved'),
    'partial', count(*) filter (where v.status = 'partially_approved'),
    'declined', count(*) filter (where v.status = 'declined'),
    'expired', count(*) filter (where v.status = 'expired'),
    'pending', count(*) filter (where v.status = 'sent'),
    'conversion_pct', round(100.0 * count(*) filter (where v.status in ('approved','partially_approved'))
          / nullif(count(*) filter (where v.status in ('approved','partially_approved','declined')), 0), 1),
    'sent_total_cents', case when private.has_perm(p_workshop,'prices.view') then coalesce(sum(v.total_cents),0) end,
    'approved_total_cents', case when private.has_perm(p_workshop,'prices.view') then
          coalesce((select sum(d.total_approved_cents) from public.quote_decisions d where d.version_id = any(array_agg(v.id))),0) end
  ) into r
  from public.quote_versions v where v.workshop_id = p_workshop and v.sent_at is not null
   and (v.sent_at at time zone tz)::date between p_from and p_to;
  return r;
end $$;

create or replace function public.report_financial(p_workshop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; today date; r jsonb;
begin
  perform private.require_perm(p_workshop, 'reports.financial');
  select timezone into tz from public.workshops where id = p_workshop;
  today := (now() at time zone tz)::date;
  select jsonb_build_object(
    'definicoes', jsonb_build_object(
      'previsto', 'Parcelas a receber com vencimento no período (contas não canceladas).',
      'faturado', 'Total aprovado das OS entregues no período.',
      'recebido', 'Pagamentos líquidos (menos estornos) registrados no período.',
      'vencido', 'Saldo de parcelas a receber vencidas até hoje.',
      'despesas_pagas', 'Pagamentos de contas a pagar no período.',
      'margem_gerencial', 'Itens executados das OS entregues − custos de peças e terceiros aplicados. Não é lucro líquido (despesas gerais não alocadas).',
      'ticket_medio', 'Faturado ÷ número de OS entregues no período com valor > 0. Canceladas excluídas.'),
    'previsto_cents', (select coalesce(sum(i.amount_cents),0) from public.account_installments i join public.accounts a on a.id = i.account_id
        where a.workshop_id = p_workshop and a.kind = 'receivable' and a.status <> 'cancelled' and i.due_date between p_from and p_to),
    'recebido_cents', (select coalesce(sum(p.amount_cents),0) from public.account_payments p join public.account_installments i on i.id = p.installment_id
        join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'receivable'
        and (p.paid_at at time zone tz)::date between p_from and p_to),
    'vencido_cents', (select coalesce(sum(i.amount_cents - i.paid_cents),0) from public.account_installments i join public.accounts a on a.id = i.account_id
        where a.workshop_id = p_workshop and a.kind = 'receivable' and a.status = 'open' and i.due_date < today),
    'a_pagar_periodo_cents', (select coalesce(sum(i.amount_cents - i.paid_cents),0) from public.account_installments i join public.accounts a on a.id = i.account_id
        where a.workshop_id = p_workshop and a.kind = 'payable' and a.status = 'open' and i.due_date between p_from and p_to),
    'despesas_pagas_cents', (select coalesce(sum(p.amount_cents),0) from public.account_payments p join public.account_installments i on i.id = p.installment_id
        join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'payable'
        and (p.paid_at at time zone tz)::date between p_from and p_to),
    'taxas_cents', (select coalesce(sum(p.fee_cents),0) from public.account_payments p where p.workshop_id = p_workshop
        and (p.paid_at at time zone tz)::date between p_from and p_to),
    'faturado_cents', f.fat, 'entregues', f.n, 'ticket_medio_cents', case when f.n_val > 0 then round(f.fat::numeric / f.n_val) end,
    'margem_gerencial_cents', case when private.has_perm(p_workshop,'margins.view') then f.fat - f.custo end,
    'by_method', (select coalesce(jsonb_object_agg(method, s), '{}'::jsonb) from (select p.method, sum(p.amount_cents) s from public.account_payments p
        where p.workshop_id = p_workshop and (p.paid_at at time zone tz)::date between p_from and p_to group by p.method) m)
  ) into r
  from (select coalesce(sum(t.rev),0) fat, coalesce(sum(t.cost),0) custo, count(*) n, count(*) filter (where t.rev > 0) n_val
          from (select o.id, (select coalesce(sum(i.total_cents),0) from public.order_items i where i.order_id = o.id and i.status = 'done') rev,
                       (select coalesce(sum(c.total_cost_cents),0) from public.order_items i join public.order_item_costs c on c.item_id = i.id
                         where i.order_id = o.id and i.status = 'done') cost
                  from public.service_orders o where o.workshop_id = p_workshop and o.status = 'delivered'
                   and (o.delivered_at at time zone tz)::date between p_from and p_to) t) f;
  return r;
end $$;

create or replace function public.report_maintenance(p_workshop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; r jsonb;
begin
  perform private.require_perm(p_workshop, 'reports.view');
  select timezone into tz from public.workshops where id = p_workshop;
  select jsonb_build_object(
    'definicao', 'Ciclos com data alvo no período. "Concluídos aqui" = encerrados por OS entregue desta oficina. Retorno só é atribuído a contato quando há registro de contato no ciclo antes do agendamento.',
    'eligible', count(*),
    'contacted', count(*) filter (where c.last_contact_at is not null),
    'scheduled', count(*) filter (where c.contact_status = 'scheduled'),
    'completed_here', count(*) filter (where c.close_kind = 'executed_here'),
    'completed_elsewhere', count(*) filter (where c.close_kind = 'external'),
    'completed_after_contact', count(*) filter (where c.close_kind = 'executed_here' and exists
        (select 1 from public.contact_log l where l.cycle_id = c.id and l.created_at < c.closed_at)),
    'refused', count(*) filter (where c.contact_status = 'refused'),
    'no_consent', count(*) filter (where c.contact_status = 'no_consent')
  ) into r
  from public.maintenance_cycles c where c.workshop_id = p_workshop and c.target_date between p_from and p_to;
  return r;
end $$;

create or replace function public.report_inactive_clients(p_workshop uuid, p_months int)
returns table(client_id uuid, name text, phone text, last_visit date, vehicles text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.name, c.phone, max(o.entry_at)::date,
         string_agg(distinct coalesce(v.plate, v.internal_code), ', ')
    from public.clients c
    left join public.service_orders o on o.client_id = c.id and o.status = 'delivered'
    left join public.vehicle_ownerships ow on ow.client_id = c.id and ow.ended_at is null
    left join public.vehicles v on v.id = ow.vehicle_id
   where c.workshop_id = p_workshop and c.archived_at is null and private.has_perm(p_workshop, 'reports.view')
     and private.has_perm(p_workshop, 'clients.view')
   group by c.id, c.name, c.phone
  having max(o.entry_at) is null or max(o.entry_at) < now() - make_interval(months => p_months)
   order by max(o.entry_at) nulls first limit 500
$$;

create or replace function public.report_team(p_workshop uuid, p_from date, p_to date)
returns table(membership_id uuid, name text, hours numeric, orders int, items_done int)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, pr.full_name,
    round(coalesce((select sum(extract(epoch from (coalesce(t.ended_at, now()) - t.started_at)))/3600 from public.time_entries t
       where t.membership_id = m.id and t.started_at::date between p_from and p_to), 0)::numeric, 1),
    (select count(distinct t.order_id)::int from public.time_entries t where t.membership_id = m.id and t.started_at::date between p_from and p_to),
    (select count(*)::int from public.order_items i join public.service_orders o on o.id = i.order_id
      where i.assigned_membership_id = m.id and i.status = 'done' and o.ready_at::date between p_from and p_to)
  from public.memberships m join public.profiles pr on pr.user_id = m.user_id
  where m.workshop_id = p_workshop and private.has_perm(p_workshop, 'reports.view')
$$;

-- Exportações registradas
create or replace function public.log_export(p_workshop uuid, p_resource text, p_filters jsonb, p_rows int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_perm(p_workshop, 'reports.export');
  perform private.audit(p_workshop, 'export', p_resource, null, jsonb_build_object('filtros', p_filters, 'linhas', p_rows));
end $$;

-- Painel adaptado ao perfil
create or replace function public.dashboard_summary(p_workshop uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; today date; r jsonb := '{}'::jsonb; mid uuid;
begin
  if not private.is_member(p_workshop) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select timezone into tz from public.workshops where id = p_workshop;
  today := (now() at time zone tz)::date;
  mid := private.current_membership_id(p_workshop);
  if private.has_perm(p_workshop, 'schedule.view') then
    r := r || jsonb_build_object('appointments_today', (select count(*) from public.appointments where workshop_id = p_workshop
             and (starts_at at time zone tz)::date = today and status in ('requested','confirmed','arrived')),
           'appointments_next_days', (select count(*) from public.appointments where workshop_id = p_workshop
             and (starts_at at time zone tz)::date between today + 1 and today + 7 and status in ('requested','confirmed')));
  end if;
  if private.has_perm(p_workshop, 'orders.view') then
    r := r || jsonb_build_object(
      'in_shop', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.service_orders o
           where workshop_id = p_workshop and status not in ('delivered','cancelled') and private.can_see_order(o.id) group by status) s),
      'late', (select count(*) from public.service_orders o where workshop_id = p_workshop and expected_delivery_at < now()
           and status not in ('ready','delivered','cancelled') and private.can_see_order(o.id)),
      'deliveries_today', (select count(*) from public.service_orders o where workshop_id = p_workshop
           and (expected_delivery_at at time zone tz)::date = today and status not in ('delivered','cancelled') and private.can_see_order(o.id)),
      'parts_pending', (select count(*) from public.service_orders o where workshop_id = p_workshop and parts_pending
           and status not in ('delivered','cancelled') and private.can_see_order(o.id)),
      'my_open_timer', (select to_jsonb(t) from public.time_entries t where t.membership_id = mid and t.ended_at is null));
  end if;
  if private.has_perm(p_workshop, 'quotes.view') then
    r := r || jsonb_build_object('quotes_awaiting', (select count(*) from public.quotes where workshop_id = p_workshop and status = 'sent'));
  end if;
  if private.has_perm(p_workshop, 'inventory.view') then
    r := r || jsonb_build_object('low_stock', (select count(*) from public.products p join public.stock_balances b on b.product_id = p.id
           where p.workshop_id = p_workshop and p.archived_at is null and p.min_stock > 0 and b.on_hand - b.reserved <= p.min_stock));
  end if;
  if private.has_perm(p_workshop, 'maintenance.view') then
    r := r || jsonb_build_object('maintenance', (select coalesce(jsonb_object_agg(st, n), '{}'::jsonb) from (
           select ts.status st, count(*) n from public.maintenance_cycles c cross join lateral public.cycle_technical_status(c.id) ts
            where c.workshop_id = p_workshop and c.status = 'open' group by ts.status) x));
  end if;
  if private.has_perm(p_workshop, 'contacts.view') then
    r := r || jsonb_build_object('contact_tasks_open', (select count(*) from public.contact_tasks where workshop_id = p_workshop
           and status = 'open' and due_on <= today));
  end if;
  if private.has_perm(p_workshop, 'finance.view') then
    r := r || jsonb_build_object(
      'receivable_overdue_cents', (select coalesce(sum(i.amount_cents - i.paid_cents),0) from public.account_installments i
          join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'receivable' and a.status = 'open' and i.due_date < today),
      'received_today_cents', (select coalesce(sum(p.amount_cents),0) from public.account_payments p join public.account_installments i on i.id = p.installment_id
          join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'receivable' and (p.paid_at at time zone tz)::date = today),
      'payable_due_7d_cents', (select coalesce(sum(i.amount_cents - i.paid_cents),0) from public.account_installments i
          join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'payable' and a.status = 'open'
          and i.due_date <= today + 7),
      'cash_open', exists (select 1 from public.cash_sessions where workshop_id = p_workshop and closed_at is null));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.products enable row level security;
alter table public.product_costs enable row level security;
alter table public.stock_balances enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.inventory_counts enable row level security;
alter table public.inventory_count_items enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_items enable row level security;
alter table public.accounts enable row level security;
alter table public.account_installments enable row level security;
alter table public.account_payments enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.cash_movements enable row level security;
alter table public.commission_rules enable row level security;
alter table public.commission_entries enable row level security;

create policy prod_select on public.products for select to authenticated using (private.is_member(workshop_id));
create policy prod_insert on public.products for insert to authenticated with check (private.has_perm(workshop_id,'inventory.edit'));
create policy prod_update on public.products for update to authenticated
  using (private.has_perm(workshop_id,'inventory.edit')) with check (private.has_perm(workshop_id,'inventory.edit'));
create policy pcost_select on public.product_costs for select to authenticated using (private.has_perm(workshop_id,'costs.view'));
create policy sb_select on public.stock_balances for select to authenticated using (private.has_perm(workshop_id,'inventory.view'));
create policy sm_select on public.stock_movements for select to authenticated
  using (private.has_perm(workshop_id,'inventory.view') and private.has_perm(workshop_id,'costs.view'));
create policy sr_select on public.stock_reservations for select to authenticated
  using (private.has_perm(workshop_id,'inventory.view') or private.can_see_order(order_id));
create policy ic_all on public.inventory_counts for select to authenticated using (private.has_perm(workshop_id,'inventory.view'));
create policy ic_ins on public.inventory_counts for insert to authenticated with check (private.has_perm(workshop_id,'inventory.adjust'));
create policy ici_sel on public.inventory_count_items for select to authenticated using (private.has_perm(workshop_id,'inventory.view'));
create policy ici_ins on public.inventory_count_items for insert to authenticated with check (private.has_perm(workshop_id,'inventory.adjust')
  and exists (select 1 from public.inventory_counts c where c.id = count_id and c.status = 'open'));
create policy ici_upd on public.inventory_count_items for update to authenticated using (private.has_perm(workshop_id,'inventory.adjust')
  and exists (select 1 from public.inventory_counts c where c.id = count_id and c.status = 'open'));

create policy sup_select on public.suppliers for select to authenticated
  using (private.has_perm(workshop_id,'purchasing.view') or private.has_perm(workshop_id,'finance.view'));
create policy sup_insert on public.suppliers for insert to authenticated with check (private.has_perm(workshop_id,'purchasing.edit'));
create policy sup_update on public.suppliers for update to authenticated
  using (private.has_perm(workshop_id,'purchasing.edit')) with check (private.has_perm(workshop_id,'purchasing.edit'));
create policy po_select on public.purchase_orders for select to authenticated using (private.has_perm(workshop_id,'purchasing.view'));
create policy poi_select on public.purchase_order_items for select to authenticated
  using (private.has_perm(workshop_id,'purchasing.view') and private.has_perm(workshop_id,'costs.view'));
create policy pr_select on public.purchase_receipts for select to authenticated using (private.has_perm(workshop_id,'purchasing.view'));
create policy pri_select on public.purchase_receipt_items for select to authenticated
  using (private.has_perm(workshop_id,'purchasing.view') and private.has_perm(workshop_id,'costs.view'));

create policy acc_select on public.accounts for select to authenticated using (private.has_perm(workshop_id,'finance.view'));
create policy ai_select on public.account_installments for select to authenticated using (private.has_perm(workshop_id,'finance.view'));
create policy ap_select on public.account_payments for select to authenticated using (private.has_perm(workshop_id,'finance.view'));
create policy cs_select on public.cash_sessions for select to authenticated using (private.has_perm(workshop_id,'cash.operate'));
create policy cm_select on public.cash_movements for select to authenticated using (private.has_perm(workshop_id,'cash.operate'));
create policy cr_select on public.commission_rules for select to authenticated using (private.has_perm(workshop_id,'commissions.manage'));
create policy cr_write on public.commission_rules for all to authenticated
  using (private.has_perm(workshop_id,'commissions.manage')) with check (private.has_perm(workshop_id,'commissions.manage'));
create policy ce_select on public.commission_entries for select to authenticated
  using (private.has_perm(workshop_id,'commissions.manage')
         or (private.has_perm(workshop_id,'commissions.view_own') and membership_id = private.current_membership_id(workshop_id)));
