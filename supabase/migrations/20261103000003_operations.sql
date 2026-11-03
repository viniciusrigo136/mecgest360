-- =====================================================================
-- Fase 2: Agenda, recepção, catálogo, OS, checklist, execução,
-- orçamentos versionados, aprovação e portal do cliente.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Recursos (boxes/elevadores) e bloqueios de agenda
-- ---------------------------------------------------------------------
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  name text not null,
  kind text not null default 'box',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workshop_id, id)
);

create table public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  resource_id uuid,
  membership_id uuid,
  reason text not null,          -- feriado, manutenção do box, folga...
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, resource_id) references public.resources(workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id)
);
create index on public.schedule_blocks(workshop_id, starts_at);

-- ---------------------------------------------------------------------
-- Catálogo de serviços (preço é copiado para os documentos)
-- ---------------------------------------------------------------------
create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  name text not null,
  description text,
  category text,
  duration_min int not null default 60 check (duration_min between 5 and 10080),
  base_price_cents bigint not null default 0 check (base_price_cents >= 0),
  maintenance_component text,         -- componente que este serviço atende (ex.: 'oleo_motor')
  suggested_interval_months int,      -- sugestão editável, nunca aplicada silenciosamente
  suggested_interval_km int,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id)
);
create trigger trg_catalog_touch before update on public.service_catalog
  for each row execute function private.touch_updated_at();
create trigger trg_audit_catalog after insert or update on public.service_catalog
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- Agendamentos
-- ---------------------------------------------------------------------
create type public.appointment_status as enum
  ('requested','confirmed','arrived','converted','completed','cancelled','no_show');

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  client_id uuid not null,
  vehicle_id uuid,
  service_id uuid,
  description text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  membership_id uuid,
  resource_id uuid,
  status public.appointment_status not null default 'confirmed',
  source text not null default 'balcao',     -- balcao, telefone, portal, retorno_preventivo
  cancel_reason text,
  override_reason text,                      -- conflito liberado por permissão
  rescheduled_from uuid references public.appointments(id),
  order_id uuid,
  maintenance_cycle_id uuid,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, service_id) references public.service_catalog(workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id),
  foreign key (workshop_id, resource_id) references public.resources(workshop_id, id),
  -- Concorrência garantida pelo banco: sem sobreposição de box nem de funcionário
  constraint no_resource_overlap exclude using gist
    (resource_id with =, tstzrange(starts_at, ends_at) with &&)
    where (resource_id is not null and override_reason is null
           and status in ('requested','confirmed','arrived')),
  constraint no_member_overlap exclude using gist
    (membership_id with =, tstzrange(starts_at, ends_at) with &&)
    where (membership_id is not null and override_reason is null
           and status in ('confirmed','arrived'))
);
create index on public.appointments(workshop_id, starts_at);
create unique index appointments_one_order on public.appointments(order_id) where order_id is not null;
create trigger trg_appt_touch before update on public.appointments
  for each row execute function private.touch_updated_at();
create trigger trg_audit_appt after insert or update on public.appointments
  for each row execute function private.audit_row();

-- Verifica horário de funcionamento e bloqueios (no fuso da oficina)
create or replace function private.check_schedule_window(p_ws uuid, p_start timestamptz, p_end timestamptz,
                                                        p_resource uuid, p_member uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w public.workshops; ls timestamp; le timestamp; dow text; slot jsonb; ok boolean := false;
begin
  select * into w from public.workshops where id = p_ws;
  ls := p_start at time zone w.timezone; le := p_end at time zone w.timezone;
  if ls::date <> le::date then return 'Agendamento deve começar e terminar no mesmo dia'; end if;
  dow := extract(dow from ls)::int::text;
  for slot in select * from jsonb_array_elements(coalesce(w.business_hours->dow, '[]'::jsonb)) loop
    if ls::time >= (slot->>0)::time and le::time <= (slot->>1)::time then ok := true; end if;
  end loop;
  if not ok then return 'Fora do horário de funcionamento (ou atravessa uma pausa)'; end if;
  if exists (select 1 from public.schedule_blocks b where b.workshop_id = p_ws
               and tstzrange(b.starts_at, b.ends_at) && tstzrange(p_start, p_end)
               and (b.resource_id is null and b.membership_id is null
                    or b.resource_id = p_resource or b.membership_id = p_member)) then
    return 'Horário bloqueado (feriado, folga ou box indisponível)';
  end if;
  return null;
end $$;

create or replace function public.save_appointment(
  p_workshop uuid, p_id uuid, p_client uuid, p_vehicle uuid, p_service uuid, p_description text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_member uuid, p_resource uuid,
  p_status public.appointment_status default 'confirmed', p_override_reason text default null,
  p_notes text default null, p_expected_version int default null, p_source text default 'balcao')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_err text; cur public.appointments;
begin
  if p_id is null then perform private.require_perm(p_workshop, 'schedule.create');
  else perform private.require_perm(p_workshop, 'schedule.edit'); end if;
  if p_override_reason is not null then
    perform private.require_perm(p_workshop, 'schedule.override');
    if length(trim(p_override_reason)) < 5 then raise exception 'Justifique o encaixe com conflito'; end if;
  else
    v_err := private.check_schedule_window(p_workshop, p_starts_at, p_ends_at, p_resource, p_member);
    if v_err is not null then raise exception '%', v_err using errcode = 'P0003'; end if;
  end if;
  begin
    if p_id is null then
      insert into public.appointments(workshop_id, client_id, vehicle_id, service_id, description, starts_at, ends_at,
                                      membership_id, resource_id, status, override_reason, notes, source)
      values (p_workshop, p_client, p_vehicle, p_service, p_description, p_starts_at, p_ends_at,
              p_member, p_resource, p_status, p_override_reason, p_notes, p_source)
      returning id into v_id;
    else
      select * into cur from public.appointments where id = p_id and workshop_id = p_workshop for update;
      if cur.id is null then raise exception 'Agendamento não encontrado'; end if;
      if p_expected_version is not null and cur.version <> p_expected_version then
        raise exception 'Agendamento alterado por outra pessoa. Recarregue.' using errcode = '40001';
      end if;
      if cur.status in ('converted','completed','cancelled','no_show') then
        raise exception 'Agendamento encerrado não pode ser alterado';
      end if;
      if cur.starts_at <> p_starts_at or cur.ends_at <> p_ends_at then
        -- Reagendamento preserva histórico: encerra o atual e cria um novo
        update public.appointments set status = 'cancelled', cancel_reason = 'Reagendado' where id = p_id;
        insert into public.appointments(workshop_id, client_id, vehicle_id, service_id, description, starts_at, ends_at,
                                        membership_id, resource_id, status, override_reason, notes, rescheduled_from,
                                        source, maintenance_cycle_id)
        values (p_workshop, p_client, p_vehicle, p_service, p_description, p_starts_at, p_ends_at,
                p_member, p_resource, case when p_status = 'requested' then 'requested' else 'confirmed' end,
                p_override_reason, p_notes, p_id, cur.source, cur.maintenance_cycle_id)
        returning id into v_id;
      else
        update public.appointments set client_id = p_client, vehicle_id = p_vehicle, service_id = p_service,
          description = p_description, membership_id = p_member, resource_id = p_resource,
          status = p_status, override_reason = p_override_reason, notes = p_notes
        where id = p_id returning id into v_id;
      end if;
    end if;
  exception when exclusion_violation then
    raise exception 'Conflito de horário: o box ou o funcionário já está ocupado nesse período'
      using errcode = 'P0004';
  end;
  return v_id;
end $$;

create or replace function public.set_appointment_status(p_id uuid, p_status public.appointment_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments;
begin
  select * into a from public.appointments where id = p_id for update;
  if a.id is null then raise exception 'Agendamento não encontrado'; end if;
  if p_status = 'cancelled' then
    perform private.require_perm(a.workshop_id, 'schedule.cancel');
    if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo do cancelamento'; end if;
  else perform private.require_perm(a.workshop_id, 'schedule.edit'); end if;
  if a.status in ('converted','completed','cancelled') then raise exception 'Agendamento já encerrado'; end if;
  if p_status = 'converted' then raise exception 'Use a conversão em OS'; end if;
  update public.appointments set status = p_status,
         cancel_reason = case when p_status = 'cancelled' then p_reason else cancel_reason end
   where id = p_id;
  -- Não comparecimento gera tarefa de retorno
  if p_status = 'no_show' then
    insert into public.contact_tasks(workshop_id, client_id, vehicle_id, reason, due_on, appointment_id)
    values (a.workshop_id, a.client_id, a.vehicle_id, 'Não compareceu ao agendamento — reagendar', current_date, a.id);
  end if;
  -- Cancelamento ligado a retorno preventivo volta para revisão (sem disparo automático)
  if p_status = 'cancelled' and a.maintenance_cycle_id is not null then
    update public.maintenance_cycles set contact_status = 'pending' where id = a.maintenance_cycle_id
       and contact_status = 'scheduled';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Ordens de serviço
-- ---------------------------------------------------------------------
create type public.order_status as enum
  ('open','diagnosis','awaiting_approval','approved','in_progress','quality_check','ready','delivered','cancelled');
create type public.item_kind as enum ('service','part','third_party');
create type public.item_status as enum
  ('pending_approval','approved','declined','in_progress','done','not_done','cancelled');

create table public.service_orders (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  number text not null,
  client_id uuid not null,
  vehicle_id uuid not null,
  responsible_membership_id uuid,
  origin text not null default 'balcao' check (origin in ('balcao','agendamento','garantia','portal','retorno_preventivo')),
  appointment_id uuid,
  warranty_of_order_id uuid,
  warranty_notes text,
  status public.order_status not null default 'open',
  parts_pending boolean not null default false,
  parts_pending_note text,
  entry_at timestamptz not null default now(),
  expected_delivery_at timestamptz,
  km_entry int,
  fuel_level int check (fuel_level between 0 and 8),   -- oitavos do tanque
  complaint text,
  diagnosis text,
  notes_internal text,
  notes_client text,
  warranty_terms text,
  cancel_reason text,
  ready_at timestamptz,
  ready_by uuid,
  delivered_at timestamptz,
  delivered_by uuid,
  delivery_notes text,
  delivery_payment_note text,
  maintenance_decision text check (maintenance_decision in ('registered','not_applicable')),
  maintenance_decision_note text,
  reopen_count int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  unique (workshop_id, number),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, responsible_membership_id) references public.memberships(workshop_id, id),
  foreign key (workshop_id, appointment_id) references public.appointments(workshop_id, id),
  foreign key (workshop_id, warranty_of_order_id) references public.service_orders(workshop_id, id)
);
create unique index orders_one_per_appointment on public.service_orders(appointment_id) where appointment_id is not null;
create index on public.service_orders(workshop_id, status, entry_at desc);
create index on public.service_orders(vehicle_id, entry_at desc);
create index on public.service_orders(client_id);
create trigger trg_orders_touch before update on public.service_orders
  for each row execute function private.touch_updated_at();
create trigger trg_audit_orders after insert or update on public.service_orders
  for each row execute function private.audit_row();

alter table public.appointments add constraint appt_order_fk
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id);
alter table public.odometer_readings add constraint odo_order_fk
  foreign key (order_id) references public.service_orders(id);

create table public.order_assignments (
  workshop_id uuid not null,
  order_id uuid not null,
  membership_id uuid not null,
  assigned_by uuid default auth.uid(),
  assigned_at timestamptz not null default now(),
  primary key (order_id, membership_id),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id)
);
create index on public.order_assignments(membership_id);
create trigger trg_audit_assign after insert or delete on public.order_assignments
  for each row execute function private.audit_row();

create table public.order_status_history (
  id bigint generated always as identity primary key,
  workshop_id uuid not null,
  order_id uuid not null,
  from_status public.order_status,
  to_status public.order_status not null,
  reason text,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create index on public.order_status_history(order_id, changed_at);

-- Escopo de registros: OS atribuídas x todas
create or replace function private.can_see_order(p_order uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return exists (
    select 1 from public.service_orders o
      join public.memberships m on m.workshop_id = o.workshop_id and m.user_id = auth.uid() and m.status = 'active'
      join public.workshops w on w.id = o.workshop_id and w.archived_at is null
     where o.id = p_order
       and private.member_has_perm(m.id, 'orders.view')
       and ( m.role = 'owner'
          or (private.member_has_perm(m.id, 'orders.view_all') and m.order_scope = 'all')
          or o.responsible_membership_id = m.id
          or exists (select 1 from public.order_assignments a where a.order_id = o.id and a.membership_id = m.id)
          or exists (select 1 from public.order_items i where i.order_id = o.id and i.assigned_membership_id = m.id)));
end $$;

create or replace function private.require_order(p_order uuid, p_perm text)
returns public.service_orders language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders;
begin
  select * into o from public.service_orders where id = p_order;
  if o.id is null or not private.can_see_order(p_order) then
    raise exception 'OS não encontrada ou sem acesso' using errcode = '42501';
  end if;
  if p_perm is not null then perform private.require_perm(o.workshop_id, p_perm); end if;
  return o;
end $$;

-- Itens comerciais. Preço visível só com prices.view (mecânico usa order_detail).
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  kind public.item_kind not null,
  description text not null,
  service_id uuid,
  product_id uuid,
  part_origin text not null default 'stock' check (part_origin in ('stock','client_supplied','direct_purchase')),
  part_origin_note text,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price_cents bigint not null default 0 check (unit_price_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null default 0,
  status public.item_status not null default 'pending_approval',
  quote_item_id uuid unique,          -- idempotência: um item aprovado gera uma linha
  approval_source text,               -- quote, onsite, internal
  onsite_authorization jsonb,         -- exceção presencial registrada
  is_addendum boolean not null default false,
  assigned_membership_id uuid,
  supplier_id uuid,                   -- serviço de terceiros
  third_party_due date,
  maintenance_component text,
  not_done_reason text,
  executed_confirmed_at timestamptz,
  sort int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, service_id) references public.service_catalog(workshop_id, id),
  foreign key (workshop_id, assigned_membership_id) references public.memberships(workshop_id, id),
  check (discount_cents <= round(quantity * unit_price_cents))
);
create index on public.order_items(order_id, sort);
create index on public.order_items(assigned_membership_id) where assigned_membership_id is not null;
create trigger trg_items_touch before update on public.order_items
  for each row execute function private.touch_updated_at();
create trigger trg_audit_items after insert or update on public.order_items
  for each row execute function private.audit_row();

-- Arredondamento definido: total do item = round_half_up(qtd × unitário) − desconto, em centavos.
create or replace function private.item_total(p_qty numeric, p_unit bigint, p_disc bigint)
returns bigint language sql immutable as $$
  select (round(p_qty * p_unit, 0))::bigint - coalesce(p_disc, 0)
$$;

create or replace function private.items_compute_total()
returns trigger language plpgsql as $$
begin
  new.total_cents := private.item_total(new.quantity, new.unit_price_cents, new.discount_cents);
  return new;
end $$;
create trigger trg_items_total before insert or update on public.order_items
  for each row execute function private.items_compute_total();

-- Custo aplicado (protegido por costs.view)
create table public.order_item_costs (
  item_id uuid primary key,
  workshop_id uuid not null,
  unit_cost_cents bigint not null default 0,
  total_cost_cents bigint not null default 0,
  cost_source text not null default 'estimate',   -- estimate, stock_avg, third_party
  updated_at timestamptz not null default now(),
  foreign key (workshop_id, item_id) references public.order_items(workshop_id, id)
);

create view public.order_totals with (security_invoker = true) as
  select i.workshop_id, i.order_id,
    coalesce(sum(i.total_cents) filter (where i.status in ('approved','in_progress','done')), 0)::bigint as approved_total_cents,
    coalesce(sum(i.total_cents) filter (where i.status = 'pending_approval'), 0)::bigint as pending_total_cents,
    coalesce(sum(i.discount_cents) filter (where i.status in ('approved','in_progress','done')), 0)::bigint as discount_cents,
    count(*) filter (where i.status in ('approved','in_progress','done')) as approved_items
  from public.order_items i group by i.workshop_id, i.order_id;

-- Checklists configuráveis
create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  kind text not null check (kind in ('entry','quality')),
  name text not null,
  items jsonb not null,          -- [{key,label}]
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workshop_id, id)
);

create table public.order_checklists (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  kind text not null check (kind in ('entry','quality')),
  items jsonb not null default '[]'::jsonb,       -- [{key,label,state:'ok'|'avaria'|'na',note}]
  belongings text,
  responsible_id uuid default auth.uid(),
  client_ack_name text,                            -- ciência do cliente (não é certificação)
  client_ack_at timestamptz,
  completed_at timestamptz,
  test_notes text,
  updated_at timestamptz not null default now(),
  unique (order_id, kind),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create trigger trg_audit_checklists after insert or update on public.order_checklists
  for each row execute function private.audit_row();

-- Anexos (bucket privado 'order-files')
create table public.order_attachments (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  storage_path text not null unique,
  kind text not null default 'photo' check (kind in ('photo','document')),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/heic','application/pdf')),
  size_bytes int not null check (size_bytes between 1 and 15728640),
  caption text,
  stage text,                       -- entrada, diagnostico, execucao, entrega
  visible_to_client boolean not null default false,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create index on public.order_attachments(order_id);

-- Linha do tempo / notas
create table public.order_events (
  id bigint generated always as identity primary key,
  workshop_id uuid not null,
  order_id uuid not null,
  kind text not null,                -- note, status, diagnosis, photo, quote, payment, delivery
  message text not null,
  visible_to_client boolean not null default false,
  author_id uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create index on public.order_events(order_id, created_at);

-- Apontamento de tempo
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  item_id uuid,
  membership_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  pause_reason text,
  edited_reason text,
  edited_by uuid,
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, item_id) references public.order_items(workshop_id, id),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id),
  check (ended_at is null or ended_at > started_at)
);
-- Um único temporizador aberto por funcionário
create unique index one_open_timer on public.time_entries(membership_id) where ended_at is null;
create trigger trg_audit_time after update on public.time_entries
  for each row execute function private.audit_row();

-- Recomendações (itens recusados/adiados e pendências não executadas)
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  vehicle_id uuid not null,
  client_id uuid,
  order_id uuid,
  quote_item_id uuid,
  description text not null,
  reason text,                       -- recusado, adiado, sem peça...
  priority text not null default 'media' check (priority in ('baixa','media','alta','critica')),
  follow_up_on date,
  status text not null default 'open' check (status in ('open','scheduled','done','dismissed')),
  critical_communicated_by uuid,     -- item crítico: comunicado por pessoa responsável
  critical_communicated_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create unique index rec_one_per_quote_item on public.recommendations(quote_item_id) where quote_item_id is not null;
create index on public.recommendations(workshop_id, status, follow_up_on);

-- ---------------------------------------------------------------------
-- Abertura de OS e conversão de agendamento (idempotente)
-- ---------------------------------------------------------------------
create or replace function public.open_order(
  p_workshop uuid, p_client uuid, p_vehicle uuid, p_complaint text, p_km int default null,
  p_fuel int default null, p_expected_delivery timestamptz default null, p_responsible uuid default null,
  p_mechanics uuid[] default '{}', p_origin text default 'balcao', p_appointment uuid default null,
  p_warranty_of uuid default null, p_km_justification text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_appt public.appointments; m uuid;
begin
  perform private.require_perm(p_workshop, 'orders.create');
  if not exists (select 1 from public.vehicle_ownerships where vehicle_id = p_vehicle and client_id = p_client
                  and ended_at is null and workshop_id = p_workshop)
     and not exists (select 1 from public.vehicle_ownerships where vehicle_id = p_vehicle and contact_client_id = p_client
                  and ended_at is null) then
    raise exception 'O veículo não está vinculado a este cliente';
  end if;
  if p_appointment is not null then
    select * into v_appt from public.appointments where id = p_appointment and workshop_id = p_workshop for update;
    if v_appt.id is null then raise exception 'Agendamento não encontrado'; end if;
    if v_appt.order_id is not null then return v_appt.order_id; end if;   -- idempotente
    if v_appt.status in ('cancelled','no_show','completed') then raise exception 'Agendamento encerrado'; end if;
  end if;
  insert into public.service_orders(workshop_id, number, client_id, vehicle_id, responsible_membership_id, origin,
     appointment_id, warranty_of_order_id, km_entry, fuel_level, complaint, expected_delivery_at, warranty_terms)
  values (p_workshop, private.next_number(p_workshop, 'order'), p_client, p_vehicle, p_responsible,
     case when p_appointment is not null then 'agendamento' when p_warranty_of is not null then 'garantia' else p_origin end,
     p_appointment, p_warranty_of, p_km, p_fuel, p_complaint, p_expected_delivery,
     (select warranty_terms from public.workshops where id = p_workshop))
  returning id into v_id;
  insert into public.order_status_history(workshop_id, order_id, to_status) values (p_workshop, v_id, 'open');
  foreach m in array coalesce(p_mechanics, '{}') loop
    insert into public.order_assignments(workshop_id, order_id, membership_id) values (p_workshop, v_id, m)
    on conflict do nothing;
  end loop;
  if p_km is not null then
    insert into public.odometer_readings(workshop_id, vehicle_id, km, source, order_id, regression_justification)
    values (p_workshop, p_vehicle, p_km, 'order_entry', v_id, p_km_justification);
  end if;
  if p_appointment is not null then
    update public.appointments set status = 'converted', order_id = v_id where id = p_appointment;
  end if;
  insert into public.order_checklists(workshop_id, order_id, kind, items)
  select p_workshop, v_id, t.kind,
         (select coalesce(jsonb_agg(e || jsonb_build_object('state', null, 'note', '')), '[]'::jsonb)
            from jsonb_array_elements(t.items) e)
    from public.checklist_templates t
   where t.workshop_id = p_workshop and t.active
     and t.id = (select id from public.checklist_templates t2 where t2.workshop_id = p_workshop and t2.kind = t.kind
                   and t2.active order by created_at limit 1);
  insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
  values (p_workshop, v_id, 'status', 'Veículo recebido na oficina', true);
  return v_id;
end $$;

create or replace function public.convert_appointment(p_appointment uuid, p_km int default null, p_fuel int default null,
                                                     p_km_justification text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; v uuid;
begin
  select * into a from public.appointments where id = p_appointment;
  if a.id is null then raise exception 'Agendamento não encontrado'; end if;
  if a.vehicle_id is null then raise exception 'Informe o veículo no agendamento antes de converter'; end if;
  v := public.open_order(a.workshop_id, a.client_id, a.vehicle_id, a.description, p_km, p_fuel, null, null,
         case when a.membership_id is null then '{}'::uuid[] else array[a.membership_id] end,
         'agendamento', a.id, null, p_km_justification);
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Transições de estado (validadas no backend)
-- ---------------------------------------------------------------------
create table public.order_transitions (
  from_status public.order_status not null,
  to_status public.order_status not null,
  permission text not null references public.permissions(key),
  primary key (from_status, to_status)
);
insert into public.order_transitions values
 ('open','diagnosis','orders.execute'),
 ('diagnosis','awaiting_approval','orders.edit'),
 ('diagnosis','approved','orders.edit'),
 ('awaiting_approval','diagnosis','orders.edit'),
 ('awaiting_approval','approved','orders.edit'),
 ('approved','in_progress','orders.execute'),
 ('in_progress','approved','orders.execute'),
 ('in_progress','quality_check','orders.execute'),
 ('in_progress','awaiting_approval','orders.edit'),
 ('quality_check','in_progress','orders.execute'),
 ('quality_check','ready','orders.execute'),
 ('ready','in_progress','orders.execute');

create or replace function public.order_transition(p_order uuid, p_to public.order_status, p_reason text default null,
                                                  p_expected_version int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; t public.order_transitions; q public.order_checklists; n int;
begin
  o := private.require_order(p_order, null);
  select * into o from public.service_orders where id = p_order for update;
  if p_expected_version is not null and o.version <> p_expected_version then
    raise exception 'OS alterada por outra pessoa. Recarregue.' using errcode = '40001';
  end if;
  if p_to in ('delivered','cancelled') then raise exception 'Use a ação própria de entrega/cancelamento'; end if;
  select * into t from public.order_transitions where from_status = o.status and to_status = p_to;
  if t.from_status is null then
    raise exception 'Transição não permitida: % → %', o.status, p_to using errcode = 'P0005';
  end if;
  perform private.require_perm(o.workshop_id, t.permission);

  if p_to = 'in_progress' then
    if not exists (select 1 from public.order_items where order_id = p_order and status in ('approved','in_progress','done')) then
      raise exception 'Nenhum item aprovado para executar';
    end if;
  end if;

  if p_to = 'ready' then
    select count(*) into n from public.order_items where order_id = p_order and status in ('approved','in_progress');
    if n > 0 then raise exception 'Revise os itens: % item(ns) aprovado(s) ainda não marcado(s) como executado ou não executado', n; end if;
    if exists (select 1 from public.order_items where order_id = p_order and status = 'done' and executed_confirmed_at is null) then
      raise exception 'Confirme a revisão dos itens executados';
    end if;
    if exists (select 1 from public.stock_reservations r where r.order_id = p_order and r.status = 'reserved') then
      raise exception 'Há peças reservadas sem consumo ou devolução';
    end if;
    select * into q from public.order_checklists where order_id = p_order and kind = 'quality';
    if q.id is not null and q.completed_at is null then raise exception 'Conclua o checklist de qualidade'; end if;
    if o.maintenance_decision is null then
      raise exception 'Defina o retorno preventivo: cadastrar plano ou marcar como não aplicável';
    end if;
    if exists (select 1 from public.time_entries where order_id = p_order and ended_at is null) then
      raise exception 'Há apontamentos de tempo em aberto nesta OS';
    end if;
    update public.service_orders set ready_at = now(), ready_by = auth.uid() where id = p_order;
  end if;

  update public.service_orders set status = p_to where id = p_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, o.status, p_to, p_reason);
  insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
  values (o.workshop_id, p_order, 'status',
    case p_to when 'diagnosis' then 'Em diagnóstico' when 'awaiting_approval' then 'Aguardando aprovação do orçamento'
      when 'approved' then 'Serviço aprovado e programado' when 'in_progress' then 'Em execução'
      when 'quality_check' then 'Em controle de qualidade' when 'ready' then 'Veículo pronto para retirada'
      else p_to::text end, true);
end $$;

create or replace function public.update_order(p_order uuid, p_expected_version int, p_fields jsonb)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; can_edit bool; v int; k text;
begin
  o := private.require_order(p_order, null);
  select * into o from public.service_orders where id = p_order for update;
  if o.version <> p_expected_version then
    raise exception 'OS alterada por outra pessoa. Recarregue para ver as alterações.' using errcode = '40001';
  end if;
  if o.status in ('delivered','cancelled') then raise exception 'OS encerrada; reabra para alterar'; end if;
  can_edit := private.has_perm(o.workshop_id, 'orders.edit');
  for k in select jsonb_object_keys(p_fields) loop
    if k in ('diagnosis','parts_pending','parts_pending_note','notes_internal') then
      if not (can_edit or private.has_perm(o.workshop_id, 'orders.execute')) then
        raise exception 'Sem permissão para alterar %', k using errcode = '42501'; end if;
    elsif k in ('complaint','notes_client','expected_delivery_at','responsible_membership_id','fuel_level',
                'maintenance_decision','maintenance_decision_note','warranty_terms','warranty_notes') then
      if not can_edit then raise exception 'Sem permissão para alterar %', k using errcode = '42501'; end if;
    else raise exception 'Campo não editável: %', k; end if;
  end loop;
  update public.service_orders set
    diagnosis = case when p_fields ? 'diagnosis' then p_fields->>'diagnosis' else diagnosis end,
    parts_pending = case when p_fields ? 'parts_pending' then (p_fields->>'parts_pending')::boolean else parts_pending end,
    parts_pending_note = case when p_fields ? 'parts_pending_note' then p_fields->>'parts_pending_note' else parts_pending_note end,
    notes_internal = case when p_fields ? 'notes_internal' then p_fields->>'notes_internal' else notes_internal end,
    complaint = case when p_fields ? 'complaint' then p_fields->>'complaint' else complaint end,
    notes_client = case when p_fields ? 'notes_client' then p_fields->>'notes_client' else notes_client end,
    expected_delivery_at = case when p_fields ? 'expected_delivery_at' then (p_fields->>'expected_delivery_at')::timestamptz else expected_delivery_at end,
    responsible_membership_id = case when p_fields ? 'responsible_membership_id' then (p_fields->>'responsible_membership_id')::uuid else responsible_membership_id end,
    fuel_level = case when p_fields ? 'fuel_level' then (p_fields->>'fuel_level')::int else fuel_level end,
    maintenance_decision = case when p_fields ? 'maintenance_decision' then p_fields->>'maintenance_decision' else maintenance_decision end,
    maintenance_decision_note = case when p_fields ? 'maintenance_decision_note' then p_fields->>'maintenance_decision_note' else maintenance_decision_note end,
    warranty_terms = case when p_fields ? 'warranty_terms' then p_fields->>'warranty_terms' else warranty_terms end,
    warranty_notes = case when p_fields ? 'warranty_notes' then p_fields->>'warranty_notes' else warranty_notes end
  where id = p_order returning version into v;
  if p_fields ? 'diagnosis' then
    insert into public.order_events(workshop_id, order_id, kind, message) values (o.workshop_id, p_order, 'diagnosis', 'Diagnóstico atualizado');
  end if;
  return v;
end $$;

create or replace function public.set_order_assignments(p_order uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; m uuid;
begin
  o := private.require_order(p_order, 'orders.assign');
  delete from public.order_assignments where order_id = p_order and not (membership_id = any(p_members));
  foreach m in array p_members loop
    insert into public.order_assignments(workshop_id, order_id, membership_id) values (o.workshop_id, p_order, m)
    on conflict do nothing;
  end loop;
end $$;

-- Itens: adição direta exige orders.edit + prices; após aprovação vira aditivo
-- pendente, exceto com autorização presencial registrada.
create or replace function public.add_order_item(
  p_order uuid, p_kind public.item_kind, p_description text, p_qty numeric, p_unit_price_cents bigint,
  p_discount_cents bigint default 0, p_service uuid default null, p_product uuid default null,
  p_part_origin text default 'stock', p_assigned uuid default null, p_maintenance_component text default null,
  p_onsite_authorization jsonb default null, p_unit_cost_cents bigint default null, p_supplier uuid default null,
  p_part_origin_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_id uuid; v_status public.item_status := 'pending_approval'; v_addendum bool := false;
        v_max numeric; v_cost bigint;
begin
  o := private.require_order(p_order, 'orders.edit');
  perform private.require_perm(o.workshop_id, 'prices.view');
  if o.status in ('delivered','cancelled','ready') then raise exception 'OS encerrada ou pronta; reabra para incluir itens'; end if;
  select max_discount_pct into v_max from public.workshops where id = o.workshop_id;
  if p_discount_cents > 0 and p_discount_cents > round(p_qty * p_unit_price_cents * v_max / 100)
     and not private.has_perm(o.workshop_id, 'discount.above_limit') then
    raise exception 'Desconto acima do limite de %%% exige autorização', v_max;
  end if;
  if p_kind = 'service' and p_service is not null and p_maintenance_component is null then
    select maintenance_component into p_maintenance_component from public.service_catalog where id = p_service;
  end if;
  if o.status in ('approved','in_progress','quality_check') then
    v_addendum := true;
    if p_onsite_authorization is not null then
      perform private.require_perm(o.workshop_id, 'quotes.approve_onsite');
      if coalesce(p_onsite_authorization->>'channel','') = '' or coalesce(p_onsite_authorization->>'authorized_by','') = '' then
        raise exception 'Autorização presencial exige canal e nome de quem autorizou';
      end if;
      p_onsite_authorization := p_onsite_authorization || jsonb_build_object('recorded_by', auth.uid(), 'recorded_at', now());
      v_status := 'approved';
    end if;
  elsif o.status in ('open','diagnosis','awaiting_approval') and p_onsite_authorization is not null then
    perform private.require_perm(o.workshop_id, 'quotes.approve_onsite');
    p_onsite_authorization := p_onsite_authorization || jsonb_build_object('recorded_by', auth.uid(), 'recorded_at', now());
    v_status := 'approved';
  end if;
  insert into public.order_items(workshop_id, order_id, kind, description, service_id, product_id, part_origin,
     part_origin_note, quantity, unit_price_cents, discount_cents, status, approval_source, onsite_authorization,
     is_addendum, assigned_membership_id, maintenance_component, supplier_id,
     sort)
  values (o.workshop_id, p_order, p_kind, p_description, p_service, p_product, coalesce(p_part_origin,'stock'),
     p_part_origin_note, p_qty, p_unit_price_cents, coalesce(p_discount_cents,0), v_status,
     case when p_onsite_authorization is not null then 'onsite' end, p_onsite_authorization, v_addendum,
     p_assigned, p_maintenance_component, p_supplier,
     (select coalesce(max(sort),0)+1 from public.order_items where order_id = p_order))
  returning id into v_id;
  v_cost := p_unit_cost_cents;
  if v_cost is null and p_product is not null then
    select avg_cost_cents into v_cost from public.product_costs where product_id = p_product;
  end if;
  if v_cost is not null and (private.has_perm(o.workshop_id,'costs.view') or p_unit_cost_cents is null) then
    insert into public.order_item_costs(item_id, workshop_id, unit_cost_cents, total_cost_cents, cost_source)
    values (v_id, o.workshop_id, v_cost, round(p_qty * v_cost), case when p_unit_cost_cents is null then 'stock_avg' else 'estimate' end);
  end if;
  return v_id;
end $$;

create or replace function public.update_order_item(p_item uuid, p_expected_version int, p_qty numeric,
   p_unit_price_cents bigint, p_discount_cents bigint, p_description text, p_assigned uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.order_items; o public.service_orders; v_max numeric;
begin
  select * into i from public.order_items where id = p_item for update;
  o := private.require_order(i.order_id, 'orders.edit');
  perform private.require_perm(o.workshop_id, 'prices.view');
  if i.version <> p_expected_version then raise exception 'Item alterado por outra pessoa. Recarregue.' using errcode = '40001'; end if;
  if i.status <> 'pending_approval' and (p_qty <> i.quantity or p_unit_price_cents <> i.unit_price_cents
                                         or p_discount_cents <> i.discount_cents) then
    raise exception 'Item já aprovado: alterações de preço/quantidade exigem novo orçamento (aditivo)';
  end if;
  if i.quote_item_id is not null and (p_qty <> i.quantity or p_unit_price_cents <> i.unit_price_cents) then
    raise exception 'Item originado de orçamento: altere por nova versão do orçamento';
  end if;
  select max_discount_pct into v_max from public.workshops where id = o.workshop_id;
  if p_discount_cents > round(p_qty * p_unit_price_cents * v_max / 100) and not private.has_perm(o.workshop_id, 'discount.above_limit') then
    raise exception 'Desconto acima do limite de %%% exige autorização', v_max;
  end if;
  update public.order_items set quantity = p_qty, unit_price_cents = p_unit_price_cents, discount_cents = p_discount_cents,
    description = p_description, assigned_membership_id = p_assigned where id = p_item;
end $$;

create or replace function public.cancel_order_item(p_item uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.order_items; o public.service_orders;
begin
  select * into i from public.order_items where id = p_item for update;
  o := private.require_order(i.order_id, 'orders.edit');
  if i.status in ('done','cancelled') then raise exception 'Item já executado ou cancelado'; end if;
  if exists (select 1 from public.stock_reservations where item_id = p_item and status = 'consumed') then
    raise exception 'Peça já consumida: devolva ao estoque antes de cancelar';
  end if;
  perform private.release_reservations(null, p_item);
  update public.order_items set status = 'cancelled', not_done_reason = p_reason where id = p_item;
end $$;

-- Progresso pelo mecânico (sem alterar preço/aprovação)
create or replace function public.set_item_progress(p_item uuid, p_status public.item_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.order_items; o public.service_orders;
begin
  select * into i from public.order_items where id = p_item for update;
  o := private.require_order(i.order_id, 'orders.execute');
  if p_status not in ('in_progress','done','not_done','approved') then raise exception 'Status inválido para execução'; end if;
  if i.status not in ('approved','in_progress','done','not_done') then
    raise exception 'Item não aprovado pelo cliente não pode ser executado';
  end if;
  if o.status not in ('in_progress','quality_check') then raise exception 'A OS precisa estar em execução'; end if;
  if p_status = 'not_done' and coalesce(trim(p_reason),'') = '' then raise exception 'Informe por que o item não foi executado'; end if;
  update public.order_items set status = p_status, not_done_reason = p_reason,
    executed_confirmed_at = null where id = p_item;
end $$;

-- Revisão final dos itens executados (pré-requisito para "pronta")
create or replace function public.confirm_items_review(p_order uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders;
begin
  o := private.require_order(p_order, 'orders.execute');
  update public.order_items set executed_confirmed_at = now() where order_id = p_order and status = 'done';
  -- itens não executados viram pendência recomendada
  insert into public.recommendations(workshop_id, vehicle_id, client_id, order_id, description, reason, priority)
  select o.workshop_id, o.vehicle_id, o.client_id, o.id, i.description, coalesce(i.not_done_reason,'Não executado'), 'media'
    from public.order_items i where i.order_id = p_order and i.status = 'not_done'
     and not exists (select 1 from public.recommendations r where r.order_id = p_order and r.description = i.description);
end $$;

-- Checklist
create or replace function public.save_checklist(p_order uuid, p_kind text, p_items jsonb, p_belongings text,
   p_complete boolean, p_client_ack_name text default null, p_test_notes text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders;
begin
  o := private.require_order(p_order, 'orders.execute');
  if p_complete and exists (select 1 from jsonb_array_elements(p_items) e where e->>'state' is null or e->>'state' = '') then
    raise exception 'Preencha todos os itens do checklist antes de concluir';
  end if;
  insert into public.order_checklists(workshop_id, order_id, kind, items, belongings, completed_at, client_ack_name,
                                      client_ack_at, test_notes)
  values (o.workshop_id, p_order, p_kind, p_items, p_belongings, case when p_complete then now() end,
          p_client_ack_name, case when p_client_ack_name is not null then now() end, p_test_notes)
  on conflict (order_id, kind) do update set items = excluded.items, belongings = excluded.belongings,
     completed_at = case when p_complete then coalesce(order_checklists.completed_at, now()) else null end,
     client_ack_name = coalesce(excluded.client_ack_name, order_checklists.client_ack_name),
     client_ack_at = coalesce(order_checklists.client_ack_at, excluded.client_ack_at),
     test_notes = excluded.test_notes, responsible_id = auth.uid(), updated_at = now();
end $$;

-- Apontamento
create or replace function public.timer_start(p_order uuid, p_item uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v uuid; mid uuid;
begin
  o := private.require_order(p_order, 'orders.execute');
  if o.status <> 'in_progress' then raise exception 'A OS precisa estar em execução para apontar tempo'; end if;
  mid := private.current_membership_id(o.workshop_id);
  begin
    insert into public.time_entries(workshop_id, order_id, item_id, membership_id) values (o.workshop_id, p_order, p_item, mid)
    returning id into v;
  exception when unique_violation then
    raise exception 'Você já tem um apontamento em andamento. Pause-o antes de iniciar outro.' using errcode = 'P0006';
  end;
  return v;
end $$;

create or replace function public.timer_stop(p_entry uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.time_entries;
begin
  select * into t from public.time_entries where id = p_entry for update;
  if t.id is null or t.membership_id <> private.current_membership_id(t.workshop_id) then
    raise exception 'Apontamento não encontrado' using errcode = '42501';
  end if;
  update public.time_entries set ended_at = now(), pause_reason = p_reason where id = p_entry and ended_at is null;
end $$;

create or replace function public.edit_time_entry(p_entry uuid, p_started timestamptz, p_ended timestamptz, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.time_entries;
begin
  select * into t from public.time_entries where id = p_entry for update;
  perform private.require_perm(t.workshop_id, 'orders.assign');
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe a justificativa da edição'; end if;
  update public.time_entries set started_at = p_started, ended_at = p_ended, edited_reason = p_reason, edited_by = auth.uid()
   where id = p_entry;
end $$;

-- Entrega, cancelamento e reabertura
create or replace function public.deliver_order(p_order uuid, p_notes text, p_payment_note text, p_km_exit int default null,
                                               p_allow_balance boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_balance bigint;
begin
  o := private.require_order(p_order, 'orders.deliver');
  select * into o from public.service_orders where id = p_order for update;
  if o.status <> 'ready' then raise exception 'Somente OS pronta pode ser entregue'; end if;
  select coalesce(sum(ai.amount_cents - ai.paid_cents), 0) into v_balance
    from public.account_installments ai join public.accounts a on a.id = ai.account_id
   where a.order_id = p_order and a.kind = 'receivable' and a.status <> 'cancelled';
  if not exists (select 1 from public.accounts where order_id = p_order and kind = 'receivable' and status <> 'cancelled')
     and exists (select 1 from public.order_items where order_id = p_order and status = 'done' and total_cents > 0) then
    if not p_allow_balance then
      raise exception 'Gere a cobrança (conta a receber) antes da entrega, ou registre a entrega com saldo a receber';
    end if;
  end if;
  if (v_balance > 0 or p_allow_balance) and coalesce(trim(p_payment_note),'') = '' then
    raise exception 'Entrega com saldo a receber exige registro da situação de pagamento';
  end if;
  if p_allow_balance and v_balance > 0 then perform private.require_perm(o.workshop_id, 'payments.receive'); end if;
  if p_km_exit is not null then
    insert into public.odometer_readings(workshop_id, vehicle_id, km, source, order_id)
    values (o.workshop_id, o.vehicle_id, p_km_exit, 'order_exit', p_order);
  end if;
  update public.service_orders set status = 'delivered', delivered_at = now(), delivered_by = auth.uid(),
    delivery_notes = p_notes, delivery_payment_note = p_payment_note where id = p_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, 'ready', 'delivered', p_payment_note);
  insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
  values (o.workshop_id, p_order, 'delivery', 'Veículo entregue', true);
  -- Fecha ciclos de manutenção pelos componentes efetivamente executados
  perform private.close_cycles_for_order(p_order);
  -- Comissões por competência
  perform private.generate_commissions(p_order, 'competencia');
end $$;

create or replace function public.cancel_order(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders;
begin
  o := private.require_order(p_order, 'orders.cancel');
  select * into o from public.service_orders where id = p_order for update;
  if o.status in ('delivered','cancelled') then raise exception 'OS já encerrada'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo do cancelamento'; end if;
  if exists (select 1 from public.stock_reservations where order_id = p_order and status = 'consumed') then
    raise exception 'Há peças consumidas nesta OS. Devolva-as ao estoque antes de cancelar.';
  end if;
  if exists (select 1 from public.account_payments p join public.account_installments ai on ai.id = p.installment_id
              join public.accounts a on a.id = ai.account_id
              where a.order_id = p_order and p.reversed_at is null and p.reverses_payment_id is null) then
    raise exception 'Há pagamentos registrados. Estorne-os antes de cancelar a OS.';
  end if;
  perform private.release_reservations(p_order, null);
  update public.order_items set status = 'cancelled' where order_id = p_order and status not in ('cancelled','declined');
  update public.time_entries set ended_at = now(), pause_reason = 'OS cancelada' where order_id = p_order and ended_at is null;
  update public.service_orders set status = 'cancelled', cancel_reason = p_reason where id = p_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, o.status, 'cancelled', p_reason);
  update public.accounts set status = 'cancelled', cancel_reason = 'OS cancelada' where order_id = p_order and status = 'open'
     and not exists (select 1 from public.account_installments ai where ai.account_id = accounts.id and ai.paid_cents > 0);
end $$;

create or replace function public.reopen_order(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders;
begin
  o := private.require_order(p_order, 'orders.reopen');
  select * into o from public.service_orders where id = p_order for update;
  if o.status not in ('ready','delivered') then raise exception 'Somente OS pronta ou entregue pode ser reaberta'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe a justificativa da reabertura'; end if;
  -- Não duplica peças, receitas, cobranças nem lembretes: nada é recriado aqui;
  -- os ciclos já fechados por esta OS permanecem (fechamento é idempotente).
  update public.service_orders set status = 'in_progress', reopen_count = reopen_count + 1, ready_at = null where id = p_order;
  update public.order_items set executed_confirmed_at = null where order_id = p_order;
  update public.order_checklists set completed_at = null where order_id = p_order and kind = 'quality';
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, o.status, 'in_progress', 'Reaberta: ' || p_reason);
end $$;

-- ---------------------------------------------------------------------
-- Orçamentos versionados
-- ---------------------------------------------------------------------
create type public.quote_status as enum
  ('draft','sent','approved','partially_approved','declined','expired','superseded');

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  number text not null,
  order_id uuid,
  client_id uuid not null,
  vehicle_id uuid not null,
  is_addendum boolean not null default false,
  status public.quote_status not null default 'draft',
  current_version_id uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  unique (workshop_id, number),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id)
);
create index on public.quotes(workshop_id, status, created_at desc);
create index on public.quotes(order_id);
create trigger trg_quotes_touch before update on public.quotes
  for each row execute function private.touch_updated_at();

create table public.quote_versions (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  quote_id uuid not null,
  version_no int not null,
  status public.quote_status not null default 'draft',
  valid_until date not null,
  estimated_days int,
  conditions text,
  payment_terms text,
  notes_client text,
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  total_cents bigint not null default 0,
  locked_at timestamptz,          -- imutável após envio/aprovação
  sent_at timestamptz,
  sent_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (quote_id, version_no),
  unique (workshop_id, id),
  foreign key (workshop_id, quote_id) references public.quotes(workshop_id, id)
);
alter table public.quotes add constraint quotes_current_version_fk
  foreign key (workshop_id, current_version_id) references public.quote_versions(workshop_id, id);

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  version_id uuid not null,
  kind public.item_kind not null,
  description text not null,
  service_id uuid,
  product_id uuid,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null,
  group_key text,              -- itens do mesmo conjunto devem ser aprovados juntos
  depends_on uuid references public.quote_items(id),
  maintenance_component text,
  priority text not null default 'media' check (priority in ('baixa','media','alta','critica')),
  sort int not null default 0,
  foreign key (workshop_id, version_id) references public.quote_versions(workshop_id, id)
);
create index on public.quote_items(version_id, sort);

create or replace function private.quote_version_locked()
returns trigger language plpgsql as $$
declare locked timestamptz;
begin
  select locked_at into locked from public.quote_versions where id = coalesce(new.version_id, old.version_id);
  if locked is not null then raise exception 'Versão de orçamento enviada/aprovada é imutável. Crie nova versão.'; end if;
  return coalesce(new, old);
end $$;
create trigger trg_quote_items_locked before insert or update or delete on public.quote_items
  for each row execute function private.quote_version_locked();

create or replace function private.quote_version_guard()
returns trigger language plpgsql as $$
begin
  if old.locked_at is not null and (new.valid_until <> old.valid_until or new.total_cents <> old.total_cents
      or new.conditions is distinct from old.conditions or new.payment_terms is distinct from old.payment_terms
      or new.notes_client is distinct from old.notes_client) then
    raise exception 'Versão de orçamento enviada/aprovada é imutável. Crie nova versão.';
  end if;
  return new;
end $$;
create trigger trg_quote_version_guard before update on public.quote_versions
  for each row execute function private.quote_version_guard();

create table public.quote_decisions (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  version_id uuid not null unique,   -- uma decisão por versão: idempotência
  decision text not null check (decision in ('approved','partially_approved','declined')),
  approved_item_ids uuid[] not null default '{}',
  total_approved_cents bigint not null,
  channel text not null check (channel in ('portal','presencial','telefone','whatsapp','email')),
  decided_by_name text not null,
  recorded_by uuid,                  -- usuário da oficina (registro feito pela oficina)
  evidence jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  foreign key (workshop_id, version_id) references public.quote_versions(workshop_id, id)
);

create or replace function private.recalc_quote_version(p_version uuid)
returns void language sql as $$
  update public.quote_versions v set
    subtotal_cents = coalesce((select sum(round(quantity*unit_price_cents)) from public.quote_items where version_id = p_version),0),
    discount_cents = coalesce((select sum(discount_cents) from public.quote_items where version_id = p_version),0),
    total_cents = coalesce((select sum(total_cents) from public.quote_items where version_id = p_version),0)
  where v.id = p_version and v.locked_at is null
$$;

-- Cria orçamento (ou nova versão) com itens; preços recalculados no servidor.
-- p_items: [{kind,description,service_id,product_id,quantity,unit_price_cents,discount_cents,group_key,priority,maintenance_component}]
create or replace function public.save_quote(
  p_workshop uuid, p_quote uuid, p_client uuid, p_vehicle uuid, p_order uuid, p_valid_until date,
  p_items jsonb, p_conditions text default null, p_payment_terms text default null, p_estimated_days int default null,
  p_notes_client text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.quotes; v public.quote_versions; v_new_no int; e jsonb; v_max numeric; v_gross bigint; v_disc bigint;
begin
  perform private.require_perm(p_workshop, 'quotes.create');
  perform private.require_perm(p_workshop, 'prices.view');
  if p_valid_until < current_date then raise exception 'Validade deve ser hoje ou futura'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'Inclua ao menos um item'; end if;
  select max_discount_pct into v_max from public.workshops where id = p_workshop;
  if p_quote is null then
    if p_order is not null and not exists (select 1 from public.service_orders where id = p_order and workshop_id = p_workshop
         and client_id = p_client and vehicle_id = p_vehicle) then
      raise exception 'OS não corresponde ao cliente/veículo';
    end if;
    insert into public.quotes(workshop_id, number, order_id, client_id, vehicle_id, is_addendum)
    values (p_workshop, private.next_number(p_workshop, 'quote'), p_order, p_client, p_vehicle,
            p_order is not null and exists (select 1 from public.service_orders where id = p_order
                                             and status in ('approved','in_progress','quality_check')))
    returning * into q;
  else
    select * into q from public.quotes where id = p_quote and workshop_id = p_workshop for update;
    if q.id is null then raise exception 'Orçamento não encontrado'; end if;
    if q.status in ('approved','partially_approved','declined') then
      -- decisões tomadas não são reabertas: alterações viram novo orçamento/aditivo
      raise exception 'Orçamento já decidido. Crie um aditivo/novo orçamento.';
    end if;
  end if;
  select * into v from public.quote_versions where id = q.current_version_id;
  if v.id is not null and v.locked_at is null then
    delete from public.quote_items where version_id = v.id;
    update public.quote_versions set valid_until = p_valid_until, conditions = p_conditions, payment_terms = p_payment_terms,
      estimated_days = p_estimated_days, notes_client = p_notes_client where id = v.id;
  else
    v_new_no := coalesce((select max(version_no) from public.quote_versions where quote_id = q.id), 0) + 1;
    if v.id is not null then
      update public.quote_versions set status = 'superseded' where id = v.id;
      update public.portal_links set revoked_at = now() where quote_id = q.id and purpose = 'approve' and revoked_at is null;
    end if;
    insert into public.quote_versions(workshop_id, quote_id, version_no, valid_until, conditions, payment_terms,
                                      estimated_days, notes_client)
    values (p_workshop, q.id, v_new_no, p_valid_until, p_conditions, p_payment_terms, p_estimated_days, p_notes_client)
    returning * into v;
    update public.quotes set current_version_id = v.id, status = 'draft' where id = q.id;
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    v_gross := round((e->>'quantity')::numeric * (e->>'unit_price_cents')::bigint);
    v_disc := coalesce((e->>'discount_cents')::bigint, 0);
    if v_disc > v_gross then raise exception 'Desconto maior que o valor do item: %', e->>'description'; end if;
    if v_disc > round(v_gross * v_max / 100) and not private.has_perm(p_workshop, 'discount.above_limit') then
      raise exception 'Desconto acima do limite de %%% em "%"', v_max, e->>'description';
    end if;
    insert into public.quote_items(workshop_id, version_id, kind, description, service_id, product_id, quantity,
       unit_price_cents, discount_cents, total_cents, group_key, priority, maintenance_component, sort)
    values (p_workshop, v.id, (e->>'kind')::public.item_kind, e->>'description', nullif(e->>'service_id','')::uuid,
       nullif(e->>'product_id','')::uuid, (e->>'quantity')::numeric, (e->>'unit_price_cents')::bigint, v_disc,
       private.item_total((e->>'quantity')::numeric, (e->>'unit_price_cents')::bigint, v_disc),
       nullif(e->>'group_key',''), coalesce(nullif(e->>'priority',''),'media'), nullif(e->>'maintenance_component',''),
       coalesce((e->>'sort')::int, 0));
  end loop;
  perform private.recalc_quote_version(v.id);
  return q.id;
end $$;

-- Envio: trava a versão (imutável) e marca como enviado.
create or replace function public.send_quote(p_quote uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_quote for update;
  perform private.require_perm(q.workshop_id, 'quotes.send');
  if q.status not in ('draft','sent') then raise exception 'Orçamento não pode ser enviado neste estado'; end if;
  update public.quote_versions set locked_at = coalesce(locked_at, now()), sent_at = coalesce(sent_at, now()),
         sent_by = coalesce(sent_by, auth.uid()), status = 'sent'
   where id = q.current_version_id;
  update public.quotes set status = 'sent' where id = p_quote;
  if q.order_id is not null then
    update public.service_orders set status = 'awaiting_approval'
     where id = q.order_id and status in ('open','diagnosis');
    insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
    values (q.workshop_id, q.order_id, 'quote', 'Orçamento ' || q.number || ' disponível para aprovação', true);
  end if;
end $$;

-- Núcleo transacional da decisão (staff e portal usam este caminho)
create or replace function private.apply_quote_decision(p_version uuid, p_approved uuid[], p_channel text,
   p_name text, p_recorded_by uuid, p_evidence jsonb, p_note text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.quote_versions; q public.quotes; n_total int; n_ok int; v_dec text; v_total bigint;
        bad record; o public.service_orders;
begin
  select * into v from public.quote_versions where id = p_version for update;
  if v.id is null then raise exception 'Orçamento não encontrado'; end if;
  select * into q from public.quotes where id = v.quote_id for update;
  -- Idempotência: decisão existente com o mesmo conteúdo devolve o resultado anterior
  if exists (select 1 from public.quote_decisions where version_id = p_version) then
    select decision into v_dec from public.quote_decisions where version_id = p_version
       and approved_item_ids @> coalesce(p_approved,'{}') and approved_item_ids <@ coalesce(p_approved,'{}');
    if v_dec is not null then return v_dec; end if;
    raise exception 'Este orçamento já recebeu uma decisão diferente' using errcode = 'P0007';
  end if;
  if q.current_version_id <> v.id or v.status = 'superseded' then
    raise exception 'Esta versão do orçamento foi substituída e não pode ser aprovada' using errcode = 'P0008';
  end if;
  if v.status <> 'sent' then raise exception 'Orçamento não está disponível para decisão' using errcode = 'P0008'; end if;
  if v.valid_until < (now() at time zone (select timezone from public.workshops where id = v.workshop_id))::date then
    update public.quote_versions set status = 'expired' where id = v.id;
    update public.quotes set status = 'expired' where id = q.id;
    raise exception 'Orçamento vencido em %', to_char(v.valid_until, 'DD/MM/YYYY') using errcode = 'P0009';
  end if;
  if exists (select unnest(coalesce(p_approved,'{}')) except select id from public.quote_items where version_id = v.id) then
    raise exception 'Itens inválidos para este orçamento';
  end if;
  -- Dependências: conjunto (group_key) aprovado inteiro; item dependente exige o principal
  for bad in
    select i.description from public.quote_items i
     where i.version_id = v.id and i.group_key is not null and i.id = any(coalesce(p_approved,'{}'))
       and exists (select 1 from public.quote_items j where j.version_id = v.id and j.group_key = i.group_key
                    and not (j.id = any(coalesce(p_approved,'{}'))))
  loop
    raise exception 'O item "%" faz parte de um conjunto que deve ser aprovado inteiro. Fale com a oficina para revisar.', bad.description
      using errcode = 'P0010';
  end loop;
  for bad in
    select i.description from public.quote_items i
     where i.version_id = v.id and i.depends_on is not null and i.id = any(coalesce(p_approved,'{}'))
       and not (i.depends_on = any(coalesce(p_approved,'{}')))
  loop
    raise exception 'O item "%" depende de outro item não aprovado', bad.description using errcode = 'P0010';
  end loop;

  select count(*), count(*) filter (where id = any(coalesce(p_approved,'{}'))),
         coalesce(sum(total_cents) filter (where id = any(coalesce(p_approved,'{}'))),0)
    into n_total, n_ok, v_total from public.quote_items where version_id = v.id;
  v_dec := case when n_ok = 0 then 'declined' when n_ok = n_total then 'approved' else 'partially_approved' end;

  insert into public.quote_decisions(workshop_id, version_id, decision, approved_item_ids, total_approved_cents, channel,
                                     decided_by_name, recorded_by, evidence, note)
  values (v.workshop_id, v.id, v_dec, coalesce(p_approved,'{}'), v_total, p_channel, p_name, p_recorded_by,
          coalesce(p_evidence,'{}'::jsonb) || jsonb_build_object('version_no', v.version_no, 'total_cents', v.total_cents,
          'items', (select jsonb_agg(jsonb_build_object('id',id,'d',description,'t',total_cents)) from public.quote_items where version_id = v.id)),
          p_note);
  update public.quote_versions set status = v_dec::public.quote_status, locked_at = coalesce(locked_at, now()) where id = v.id;
  update public.quotes set status = v_dec::public.quote_status where id = q.id;
  update public.portal_links set revoked_at = now() where quote_id = q.id and purpose = 'approve' and revoked_at is null;

  -- Itens recusados viram recomendações separadas (preservados)
  insert into public.recommendations(workshop_id, vehicle_id, client_id, order_id, quote_item_id, description, reason, priority,
                                     follow_up_on)
  select v.workshop_id, q.vehicle_id, q.client_id, q.order_id, i.id, i.description, 'Recusado no orçamento ' || q.number,
         i.priority, current_date + 30
    from public.quote_items i where i.version_id = v.id and not (i.id = any(coalesce(p_approved,'{}')))
  on conflict do nothing;

  -- Itens aprovados entram na OS (uma única vez: quote_item_id é único)
  if q.order_id is not null then
    insert into public.order_items(workshop_id, order_id, kind, description, service_id, product_id, quantity, unit_price_cents,
       discount_cents, status, quote_item_id, approval_source, is_addendum, maintenance_component, sort)
    select v.workshop_id, q.order_id, i.kind, i.description, i.service_id, i.product_id, i.quantity, i.unit_price_cents,
       i.discount_cents, 'approved', i.id, 'quote', q.is_addendum,
       coalesce(i.maintenance_component, (select maintenance_component from public.service_catalog s where s.id = i.service_id)),
       i.sort
      from public.quote_items i where i.version_id = v.id and i.id = any(coalesce(p_approved,'{}'))
    on conflict (quote_item_id) do nothing;
    -- custos estimados dos itens com produto
    insert into public.order_item_costs(item_id, workshop_id, unit_cost_cents, total_cost_cents, cost_source)
    select oi.id, oi.workshop_id, p.avg_cost_cents, round(oi.quantity * p.avg_cost_cents), 'stock_avg'
      from public.order_items oi join public.product_costs p on p.product_id = oi.product_id
     where oi.order_id = q.order_id and oi.quote_item_id = any(coalesce(p_approved,'{}'))
    on conflict do nothing;
    select * into o from public.service_orders where id = q.order_id for update;
    if v_dec <> 'declined' and o.status in ('open','diagnosis','awaiting_approval') then
      update public.service_orders set status = 'approved' where id = o.id;
      insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
      values (o.workshop_id, o.id, o.status, 'approved', 'Orçamento ' || q.number || ' ' || v_dec);
    end if;
    insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
    values (v.workshop_id, q.order_id, 'quote',
            'Orçamento ' || q.number || case v_dec when 'approved' then ' aprovado' when 'declined' then ' recusado'
            else ' aprovado parcialmente' end || ' por ' || p_name || ' (' || p_channel || ')', true);
  end if;
  return v_dec;
end $$;

-- Registro de aprovação presencial/telefone feito pela oficina
create or replace function public.record_quote_decision(p_quote uuid, p_approved uuid[], p_channel text, p_name text, p_note text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_quote;
  perform private.require_perm(q.workshop_id, 'quotes.approve_onsite');
  if p_channel not in ('presencial','telefone','whatsapp','email') then raise exception 'Canal inválido'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Informe o nome de quem decidiu'; end if;
  return private.apply_quote_decision(q.current_version_id, p_approved, p_channel, p_name, auth.uid(),
     jsonb_build_object('registro', 'feito pela oficina', 'usuario', auth.uid()), p_note);
end $$;

-- Converte orçamento avulso aprovado em OS (idempotente)
create or replace function public.convert_quote_to_order(p_quote uuid, p_km int default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.quotes; d public.quote_decisions; v_order uuid;
begin
  select * into q from public.quotes where id = p_quote for update;
  perform private.require_perm(q.workshop_id, 'orders.create');
  if q.order_id is not null then return q.order_id; end if;
  if q.status not in ('approved','partially_approved') then raise exception 'Somente orçamento aprovado pode virar OS'; end if;
  select * into d from public.quote_decisions where version_id = q.current_version_id;
  v_order := public.open_order(q.workshop_id, q.client_id, q.vehicle_id, 'Conforme orçamento ' || q.number, p_km);
  update public.quotes set order_id = v_order where id = q.id;
  insert into public.order_items(workshop_id, order_id, kind, description, service_id, product_id, quantity, unit_price_cents,
     discount_cents, status, quote_item_id, approval_source, maintenance_component, sort)
  select q.workshop_id, v_order, i.kind, i.description, i.service_id, i.product_id, i.quantity, i.unit_price_cents,
     i.discount_cents, 'approved', i.id, 'quote',
     coalesce(i.maintenance_component, (select maintenance_component from public.service_catalog s where s.id = i.service_id)), i.sort
    from public.quote_items i where i.version_id = q.current_version_id and i.id = any(d.approved_item_ids)
  on conflict (quote_item_id) do nothing;
  update public.service_orders set status = 'approved' where id = v_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (q.workshop_id, v_order, 'open', 'approved', 'Convertida do orçamento ' || q.number);
  return v_order;
end $$;

-- Expiração periódica (job)
create or replace function public.expire_quotes()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with x as (
    update public.quote_versions v set status = 'expired'
      from public.workshops w
     where w.id = v.workshop_id and v.status = 'sent'
       and v.valid_until < (now() at time zone w.timezone)::date
    returning v.quote_id)
  update public.quotes q set status = 'expired' from x where q.id = x.quote_id and q.status = 'sent';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.expire_quotes() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Portal do cliente: links com token aleatório (hash armazenado)
-- ---------------------------------------------------------------------
create table public.portal_links (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  purpose text not null check (purpose in ('track','approve')),
  order_id uuid,
  quote_id uuid,
  client_id uuid not null,
  vehicle_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  code_hash text,                -- código de verificação para aprovação
  code_channel text,             -- whatsapp_manual, whatsapp_api...
  code_attempts int not null default 0,
  locked_at timestamptz,
  last_used_at timestamptz,
  use_count int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id),
  foreign key (workshop_id, quote_id) references public.quotes(workshop_id, id),
  check (purpose <> 'approve' or quote_id is not null),
  check (order_id is not null or quote_id is not null)
);
create index on public.portal_links(order_id);
create index on public.portal_links(quote_id);

-- Gera link (token devolvido em claro uma única vez). Para aprovação,
-- devolve também o código de 6 dígitos a ser enviado ao cliente por um
-- canal da oficina (WhatsApp manual ou API). O banco guarda só hashes.
create or replace function public.create_portal_link(p_purpose text, p_order uuid, p_quote uuid, p_valid_days int default 7)
returns table(link_id uuid, token text, code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid; v_client uuid; v_vehicle uuid; v_token text := private.random_token(); v_code text; v_id uuid; v_exp timestamptz;
begin
  if p_quote is not null then
    select workshop_id, client_id, vehicle_id, coalesce(p_order, order_id) into v_ws, v_client, v_vehicle, p_order
      from public.quotes where id = p_quote;
    perform private.require_perm(v_ws, 'quotes.send');
    if p_purpose = 'approve' and not exists (select 1 from public.quotes q join public.quote_versions v on v.id = q.current_version_id
                                               where q.id = p_quote and v.status = 'sent') then
      raise exception 'Envie (trave) o orçamento antes de gerar o link de aprovação';
    end if;
  else
    select workshop_id, client_id, vehicle_id into v_ws, v_client, v_vehicle from public.service_orders where id = p_order;
    perform private.require_order(p_order, null);
    if not (private.has_perm(v_ws,'messages.send') or private.has_perm(v_ws,'orders.edit')) then
      raise exception 'Sem permissão para gerar link' using errcode = '42501';
    end if;
  end if;
  if p_purpose = 'approve' then
    v_code := lpad((('x' || encode(extensions.gen_random_bytes(4),'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    update public.portal_links set revoked_at = now() where quote_id = p_quote and purpose = 'approve' and revoked_at is null;
  end if;
  v_exp := now() + make_interval(days => least(greatest(p_valid_days,1), 60));
  insert into public.portal_links(workshop_id, purpose, order_id, quote_id, client_id, vehicle_id, token_hash, expires_at,
                                  code_hash, code_channel)
  values (v_ws, p_purpose, p_order, p_quote, v_client, v_vehicle, private.sha256_hex(v_token), v_exp,
          case when v_code is not null then private.sha256_hex(v_token || ':' || v_code) end,
          case when v_code is not null then 'whatsapp_manual' end)
  returning id into v_id;
  return query select v_id, v_token, v_code, v_exp;
end $$;

create or replace function public.revoke_portal_link(p_link uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.portal_links where id = p_link;
  if not (private.has_perm(v_ws,'quotes.send') or private.has_perm(v_ws,'orders.edit')) then
    raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.portal_links set revoked_at = now() where id = p_link;
end $$;

create or replace function private.portal_resolve(p_token text)
returns public.portal_links language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links;
begin
  if p_token is null or length(p_token) < 40 then raise exception 'Link inválido' using errcode = '28000'; end if;
  select * into l from public.portal_links where token_hash = private.sha256_hex(p_token);
  if l.id is null or l.revoked_at is not null or l.expires_at <= now() or l.locked_at is not null then
    raise exception 'Link inválido, expirado ou revogado' using errcode = '28000';
  end if;
  update public.portal_links set last_used_at = now(), use_count = use_count + 1 where id = l.id;
  return l;
end $$;

-- Somente campos liberados ao cliente. Nunca: notas internas, custos,
-- margens, dados de funcionários ou de outros clientes/atendimentos.
create or replace function public.portal_view(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links; r jsonb := '{}'::jsonb; o public.service_orders; v public.vehicles; w public.workshops;
        q public.quotes; qv public.quote_versions;
begin
  l := private.portal_resolve(p_token);
  select * into w from public.workshops where id = l.workshop_id;
  select * into v from public.vehicles where id = l.vehicle_id;
  r := jsonb_build_object(
    'purpose', l.purpose, 'expires_at', l.expires_at,
    'workshop', jsonb_build_object('name', w.name, 'phone', w.phone, 'whatsapp', w.whatsapp, 'color', w.primary_color,
                                   'address', w.address, 'logo_path', w.logo_path),
    'client_first_name', (select split_part(name,' ',1) from public.clients where id = l.client_id),
    'vehicle', jsonb_build_object('brand', v.brand, 'model', v.model, 'year', v.year_model, 'color', v.color,
      'plate_masked', case when v.plate_norm is not null then left(v.plate_norm,3) || '-**' || right(v.plate_norm,2) end));
  if l.order_id is not null then
    select * into o from public.service_orders where id = l.order_id;
    r := r || jsonb_build_object('order', jsonb_build_object(
      'number', o.number, 'status', o.status, 'entry_at', o.entry_at, 'expected_delivery_at', o.expected_delivery_at,
      'notes_client', o.notes_client, 'parts_pending', o.parts_pending, 'delivered_at', o.delivered_at,
      'warranty_terms', case when o.status in ('ready','delivered') then o.warranty_terms end,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('description', i.description, 'kind', i.kind,
                  'quantity', i.quantity, 'total_cents', i.total_cents, 'status', i.status) order by i.sort), '[]'::jsonb)
                  from public.order_items i where i.order_id = o.id and i.status in ('approved','in_progress','done','not_done')),
      'timeline', (select coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'message', e.message) order by e.created_at), '[]'::jsonb)
                  from public.order_events e where e.order_id = o.id and e.visible_to_client),
      'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'caption', a.caption, 'stage', a.stage)), '[]'::jsonb)
                  from public.order_attachments a where a.order_id = o.id and a.visible_to_client)));
  end if;
  if l.quote_id is not null then
    select * into q from public.quotes where id = l.quote_id;
    select * into qv from public.quote_versions where id = q.current_version_id;
    r := r || jsonb_build_object('quote', jsonb_build_object(
      'number', q.number, 'status', qv.status, 'version_no', qv.version_no, 'valid_until', qv.valid_until,
      'estimated_days', qv.estimated_days, 'conditions', qv.conditions, 'payment_terms', qv.payment_terms,
      'notes_client', qv.notes_client, 'subtotal_cents', qv.subtotal_cents, 'discount_cents', qv.discount_cents,
      'total_cents', qv.total_cents, 'can_decide', (l.purpose = 'approve' and qv.status = 'sent' and
          qv.valid_until >= (now() at time zone w.timezone)::date),
      'requires_code', l.code_hash is not null,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'description', i.description,
                 'quantity', i.quantity, 'unit_price_cents', i.unit_price_cents, 'discount_cents', i.discount_cents,
                 'total_cents', i.total_cents, 'group_key', i.group_key, 'depends_on', i.depends_on, 'priority', i.priority)
                 order by i.sort), '[]'::jsonb) from public.quote_items i where i.version_id = qv.id),
      'decision', (select jsonb_build_object('decision', d.decision, 'at', d.created_at, 'name', d.decided_by_name)
                    from public.quote_decisions d where d.version_id = qv.id)));
  end if;
  r := r || jsonb_build_object('next_care', (
    select coalesce(jsonb_agg(jsonb_build_object('component', p.component_label, 'target_date', c.target_date,
             'target_km', c.target_km)), '[]'::jsonb)
      from public.maintenance_plans p join public.maintenance_cycles c on c.plan_id = p.id and c.status = 'open'
     where p.vehicle_id = l.vehicle_id and p.status = 'active'
       and exists (select 1 from public.vehicle_ownerships ow where ow.vehicle_id = l.vehicle_id and ow.client_id = l.client_id
                    and ow.ended_at is null)));
  return r;
end $$;

-- Código incorreto NÃO lança exceção: a tentativa precisa ser gravada
-- (uma exceção desfaria o contador e anularia o bloqueio por força bruta).
create or replace function public.portal_decide(p_token text, p_code text, p_approved uuid[], p_name text, p_confirm boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links; v_ver uuid; v_dec text;
begin
  l := private.portal_resolve(p_token);
  if l.purpose <> 'approve' then raise exception 'Este link é apenas de acompanhamento' using errcode = '42501'; end if;
  if not coalesce(p_confirm,false) then raise exception 'Confirme a decisão explicitamente'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Informe seu nome'; end if;
  if l.code_hash is not null then
    if p_code is null or private.sha256_hex(p_token || ':' || p_code) <> l.code_hash then
      update public.portal_links set code_attempts = code_attempts + 1,
        locked_at = case when code_attempts + 1 >= 5 then now() end where id = l.id;
      return jsonb_build_object('ok', false, 'error', 'codigo_incorreto', 'attempts_left', greatest(0, 4 - l.code_attempts));
    end if;
  end if;
  select current_version_id into v_ver from public.quotes where id = l.quote_id;
  v_dec := private.apply_quote_decision(v_ver, p_approved, 'portal', trim(p_name), null,
     jsonb_build_object('link_id', l.id, 'code_verified', l.code_hash is not null, 'code_channel', l.code_channel,
                        'observacao', 'Aceite eletrônico simples via link; não é assinatura digital certificada'), null);
  return jsonb_build_object('ok', true, 'decision', v_dec);
end $$;

create or replace function public.portal_report_km(p_token text, p_km int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links;
begin
  l := private.portal_resolve(p_token);
  if p_km is null or p_km < 0 or p_km > 3000000 then raise exception 'Quilometragem inválida'; end if;
  -- leitura do cliente fica identificada e pendente de validação
  insert into public.odometer_readings(workshop_id, vehicle_id, km, source, confirmed, regression_justification, recorded_by)
  values (l.workshop_id, l.vehicle_id, p_km, 'client_portal', false, 'informada pelo cliente', null);
  insert into public.contact_tasks(workshop_id, client_id, vehicle_id, reason, due_on)
  values (l.workshop_id, l.client_id, l.vehicle_id, 'Cliente informou ' || p_km || ' km pelo portal — validar leitura', current_date);
end $$;

create or replace function public.portal_request(p_token text, p_kind text, p_message text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links;
begin
  l := private.portal_resolve(p_token);
  if p_kind not in ('contato','reagendamento','horario') then raise exception 'Tipo inválido'; end if;
  if (select count(*) from public.contact_tasks where portal_link_id = l.id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Limite de solicitações atingido. Tente amanhã ou ligue para a oficina.';
  end if;
  insert into public.contact_tasks(workshop_id, client_id, vehicle_id, reason, due_on, portal_link_id, notes)
  values (l.workshop_id, l.client_id, l.vehicle_id,
          case p_kind when 'contato' then 'Cliente pediu contato pelo portal'
                      when 'reagendamento' then 'Cliente pediu reagendamento pelo portal'
                      else 'Cliente solicitou horário pelo portal (não confirmado)' end,
          current_date, l.id, left(p_message, 1000));
end $$;

create or replace function public.portal_stop_reminders(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links;
begin
  l := private.portal_resolve(p_token);
  insert into public.contact_consents(workshop_id, client_id, purpose, granted, source, notes, recorded_by)
  values (l.workshop_id, l.client_id, 'maintenance_reminders', false, 'portal', 'Cliente clicou em parar lembretes', null),
         (l.workshop_id, l.client_id, 'promotions', false, 'portal', 'Cliente clicou em parar lembretes', null);
  update public.message_queue set status = 'cancelled', last_error = 'Consentimento retirado pelo cliente'
   where client_id = l.client_id and status = 'pending' and purpose in ('maintenance_reminders','promotions');
end $$;

-- Foto liberada ao cliente: URL temporária gerada pela função de borda
create or replace function public.portal_photo_path(p_token text, p_attachment uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links; v text;
begin
  l := private.portal_resolve(p_token);
  select storage_path into v from public.order_attachments where id = p_attachment and order_id = l.order_id and visible_to_client;
  if v is null then raise exception 'Arquivo não disponível' using errcode = '42501'; end if;
  return v;
end $$;
revoke execute on function public.portal_photo_path(text, uuid) from public, anon, authenticated;

grant execute on function public.portal_view(text), public.portal_decide(text, text, uuid[], text, boolean),
  public.portal_report_km(text, int), public.portal_request(text, text, text), public.portal_stop_reminders(text),
  public.invite_info(text) to anon;

-- ---------------------------------------------------------------------
-- Leitura detalhada da OS com visibilidade por campo
-- ---------------------------------------------------------------------
create or replace function public.order_detail(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.service_orders; ws uuid; can_price bool; can_cost bool; can_client bool; r jsonb;
begin
  select * into o from public.service_orders where id = p_order;
  if o.id is null or not private.can_see_order(p_order) then
    raise exception 'OS não encontrada ou sem acesso' using errcode = '42501';
  end if;
  ws := o.workshop_id;
  can_price := private.has_perm(ws, 'prices.view');
  can_cost := private.has_perm(ws, 'costs.view');
  can_client := private.has_perm(ws, 'clients.view');
  r := to_jsonb(o) || jsonb_build_object(
    'client', (select case when can_client then jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone,
                  'whatsapp_norm', c.whatsapp_norm, 'email', c.email)
               else jsonb_build_object('id', c.id, 'name', split_part(c.name, ' ', 1)) end
               from public.clients c where c.id = o.client_id),
    'vehicle', (select to_jsonb(v) - 'search' from public.vehicles v where v.id = o.vehicle_id),
    'assignments', (select coalesce(jsonb_agg(a.membership_id), '[]'::jsonb) from public.order_assignments a where a.order_id = o.id),
    'items', (select coalesce(jsonb_agg(
        (jsonb_build_object('id', i.id, 'kind', i.kind, 'description', i.description, 'quantity', i.quantity,
           'status', i.status, 'assigned_membership_id', i.assigned_membership_id, 'is_addendum', i.is_addendum,
           'part_origin', i.part_origin, 'product_id', i.product_id, 'service_id', i.service_id,
           'maintenance_component', i.maintenance_component, 'not_done_reason', i.not_done_reason,
           'executed_confirmed_at', i.executed_confirmed_at, 'approval_source', i.approval_source, 'version', i.version,
           'supplier_id', i.supplier_id)
         || case when can_price then jsonb_build_object('unit_price_cents', i.unit_price_cents,
                 'discount_cents', i.discount_cents, 'total_cents', i.total_cents) else '{}'::jsonb end
         || case when can_cost then jsonb_build_object('unit_cost_cents', c.unit_cost_cents, 'total_cost_cents', c.total_cost_cents)
                 else '{}'::jsonb end) order by i.sort), '[]'::jsonb)
        from public.order_items i left join public.order_item_costs c on c.item_id = i.id where i.order_id = o.id),
    'checklists', (select coalesce(jsonb_object_agg(k.kind, to_jsonb(k)), '{}'::jsonb) from public.order_checklists k where k.order_id = o.id),
    'attachments', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]'::jsonb) from public.order_attachments a where a.order_id = o.id),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb) from public.order_events e where e.order_id = o.id),
    'history', (select coalesce(jsonb_agg(to_jsonb(h) order by h.changed_at), '[]'::jsonb) from public.order_status_history h where h.order_id = o.id),
    'time_entries', (select coalesce(jsonb_agg(to_jsonb(t) order by t.started_at desc), '[]'::jsonb) from public.time_entries t where t.order_id = o.id),
    'reservations', (select coalesce(jsonb_agg(jsonb_build_object('id', r2.id, 'item_id', r2.item_id, 'product_id', r2.product_id,
                     'quantity', r2.quantity, 'status', r2.status, 'product_name', p.name)), '[]'::jsonb)
                     from public.stock_reservations r2 join public.products p on p.id = r2.product_id where r2.order_id = o.id),
    'perms', jsonb_build_object('prices', can_price, 'costs', can_cost, 'margins', private.has_perm(ws, 'margins.view'))
  );
  if can_price then
    r := r || jsonb_build_object('totals', (select to_jsonb(t) from public.order_totals t where t.order_id = o.id));
  end if;
  if can_cost and private.has_perm(ws, 'margins.view') then
    r := r || jsonb_build_object('margin', (select jsonb_build_object(
      'revenue_cents', coalesce(sum(i.total_cents),0),
      'cost_cents', coalesce(sum(c.total_cost_cents),0),
      'margin_cents', coalesce(sum(i.total_cents),0) - coalesce(sum(c.total_cost_cents),0),
      'definicao', 'Margem gerencial = itens executados − custos de peças e terceiros. Não é lucro líquido.')
      from public.order_items i left join public.order_item_costs c on c.item_id = i.id
     where i.order_id = o.id and i.status in ('approved','in_progress','done')));
  end if;
  if private.has_perm(ws, 'quotes.view') then
    r := r || jsonb_build_object('quotes', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'number', q.number,
      'status', q.status, 'is_addendum', q.is_addendum) order by q.created_at), '[]'::jsonb) from public.quotes q where q.order_id = o.id));
  end if;
  return r;
end $$;

-- Quadro de OS com escopo e campos mínimos de cliente
create or replace function public.orders_board(p_workshop uuid, p_status public.order_status[] default null,
   p_q text default null, p_limit int default 50, p_offset int default 0)
returns table(id uuid, number text, status public.order_status, parts_pending boolean, entry_at timestamptz,
              expected_delivery_at timestamptz, client_name text, vehicle_label text, plate text,
              responsible_membership_id uuid, assigned uuid[], late boolean, version int, total_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with base as (
    select o.*, c.name as cname, v.plate, v.internal_code, coalesce(v.brand || ' ','') || v.model as vlabel
      from public.service_orders o
      join public.clients c on c.id = o.client_id
      join public.vehicles v on v.id = o.vehicle_id
     where o.workshop_id = p_workshop and private.can_see_order(o.id)
       and (p_status is null or o.status = any(p_status))
       and (p_q is null or p_q = '' or o.number ilike '%' || p_q || '%' or v.plate_norm like '%' || private.norm_plate(p_q) || '%'
            or (private.has_perm(p_workshop,'clients.view') and private.norm_text(c.name) like '%' || private.norm_text(p_q) || '%'))
  )
  select b.id, b.number, b.status, b.parts_pending, b.entry_at, b.expected_delivery_at,
         case when private.has_perm(p_workshop,'clients.view') then b.cname else split_part(b.cname,' ',1) end,
         b.vlabel, coalesce(b.plate, b.internal_code), b.responsible_membership_id,
         array(select membership_id from public.order_assignments a where a.order_id = b.id),
         (b.expected_delivery_at < now() and b.status not in ('ready','delivered','cancelled')),
         b.version, count(*) over ()
    from base b order by b.entry_at desc limit p_limit offset p_offset
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.resources enable row level security;
alter table public.schedule_blocks enable row level security;
alter table public.service_catalog enable row level security;
alter table public.appointments enable row level security;
alter table public.service_orders enable row level security;
alter table public.order_assignments enable row level security;
alter table public.order_status_history enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_costs enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.order_checklists enable row level security;
alter table public.order_attachments enable row level security;
alter table public.order_events enable row level security;
alter table public.time_entries enable row level security;
alter table public.recommendations enable row level security;
alter table public.order_transitions enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_versions enable row level security;
alter table public.quote_items enable row level security;
alter table public.quote_decisions enable row level security;
alter table public.portal_links enable row level security;

create policy res_select on public.resources for select to authenticated using (private.is_member(workshop_id));
create policy res_write on public.resources for all to authenticated
  using (private.has_perm(workshop_id,'settings.manage')) with check (private.has_perm(workshop_id,'settings.manage'));
create policy blk_select on public.schedule_blocks for select to authenticated using (private.has_perm(workshop_id,'schedule.view'));
create policy blk_write on public.schedule_blocks for all to authenticated
  using (private.has_perm(workshop_id,'schedule.edit')) with check (private.has_perm(workshop_id,'schedule.edit'));
create policy cat_select on public.service_catalog for select to authenticated using (private.is_member(workshop_id));
create policy cat_write on public.service_catalog for all to authenticated
  using (private.has_perm(workshop_id,'settings.manage')) with check (private.has_perm(workshop_id,'settings.manage'));
create policy appt_select on public.appointments for select to authenticated using (private.has_perm(workshop_id,'schedule.view'));

create policy so_select on public.service_orders for select to authenticated using (private.can_see_order(id));
create policy oa_select on public.order_assignments for select to authenticated using (private.can_see_order(order_id));
create policy osh_select on public.order_status_history for select to authenticated using (private.can_see_order(order_id));
create policy oi_select on public.order_items for select to authenticated
  using (private.can_see_order(order_id) and private.has_perm(workshop_id,'prices.view'));
create policy oic_select on public.order_item_costs for select to authenticated
  using (private.has_perm(workshop_id,'costs.view'));
create policy ct_select on public.checklist_templates for select to authenticated using (private.is_member(workshop_id));
create policy ct_write on public.checklist_templates for all to authenticated
  using (private.has_perm(workshop_id,'settings.manage')) with check (private.has_perm(workshop_id,'settings.manage'));
create policy ock_select on public.order_checklists for select to authenticated using (private.can_see_order(order_id));
create policy oat_select on public.order_attachments for select to authenticated using (private.can_see_order(order_id));
create policy oat_insert on public.order_attachments for insert to authenticated
  with check (private.can_see_order(order_id) and private.has_perm(workshop_id,'orders.execute'));
create policy oat_update on public.order_attachments for update to authenticated
  using (private.has_perm(workshop_id,'orders.edit')) with check (private.has_perm(workshop_id,'orders.edit'));
create policy oev_select on public.order_events for select to authenticated using (private.can_see_order(order_id));
create policy oev_insert on public.order_events for insert to authenticated
  with check (private.can_see_order(order_id) and (private.has_perm(workshop_id,'orders.execute') or private.has_perm(workshop_id,'orders.edit'))
              and kind = 'note' and author_id = auth.uid());
create policy te_select on public.time_entries for select to authenticated
  using (private.can_see_order(order_id) and (membership_id = private.current_membership_id(workshop_id)
         or private.has_perm(workshop_id,'orders.assign')));
create policy rec_select on public.recommendations for select to authenticated
  using (private.has_perm(workshop_id,'maintenance.view') or private.has_perm(workshop_id,'quotes.view'));
create policy rec_update on public.recommendations for update to authenticated
  using (private.has_perm(workshop_id,'maintenance.edit')) with check (private.has_perm(workshop_id,'maintenance.edit'));
create policy tr_select on public.order_transitions for select to authenticated using (true);
create policy q_select on public.quotes for select to authenticated using (private.has_perm(workshop_id,'quotes.view'));
create policy qv_select on public.quote_versions for select to authenticated using (private.has_perm(workshop_id,'quotes.view'));
create policy qi_select on public.quote_items for select to authenticated
  using (private.has_perm(workshop_id,'quotes.view') and private.has_perm(workshop_id,'prices.view'));
create policy qd_select on public.quote_decisions for select to authenticated using (private.has_perm(workshop_id,'quotes.view'));
create policy pl_select on public.portal_links for select to authenticated
  using (private.has_perm(workshop_id,'quotes.send') or private.has_perm(workshop_id,'orders.edit'));

-- ---------------------------------------------------------------------
-- Storage privado: caminho = {workshop_id}/{order_id}/{arquivo}
-- ---------------------------------------------------------------------
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('order-files', 'order-files', false, 15728640,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('workshop-assets', 'workshop-assets', false, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('finance-files', 'finance-files', false, 10485760, array['image/jpeg','image/png','application/pdf'])
on conflict (id) do nothing;

create policy "order files read" on storage.objects for select to authenticated
  using (bucket_id = 'order-files' and private.can_see_order(((storage.foldername(name))[2])::uuid)
         and ((storage.foldername(name))[1])::uuid = (select workshop_id from public.service_orders where id = ((storage.foldername(name))[2])::uuid));
create policy "order files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'order-files' and private.can_see_order(((storage.foldername(name))[2])::uuid)
              and private.has_perm(((storage.foldername(name))[1])::uuid, 'orders.execute')
              and ((storage.foldername(name))[1])::uuid = (select workshop_id from public.service_orders where id = ((storage.foldername(name))[2])::uuid));
create policy "assets read" on storage.objects for select to authenticated
  using (bucket_id = 'workshop-assets' and private.is_member(((storage.foldername(name))[1])::uuid));
create policy "assets write" on storage.objects for insert to authenticated
  with check (bucket_id = 'workshop-assets' and private.has_perm(((storage.foldername(name))[1])::uuid, 'settings.manage'));
create policy "finance files read" on storage.objects for select to authenticated
  using (bucket_id = 'finance-files' and private.has_perm(((storage.foldername(name))[1])::uuid, 'finance.view'));
create policy "finance files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'finance-files' and private.has_perm(((storage.foldername(name))[1])::uuid, 'finance.edit'));
