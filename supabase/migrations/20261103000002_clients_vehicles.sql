-- =====================================================================
-- Clientes, preferências de contato, veículos, propriedade e km
-- Isolamento: chaves compostas (workshop_id, id) impedem vínculos
-- entre oficinas diferentes.
-- =====================================================================

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create or replace function private.norm_text(p text)
returns text language sql immutable as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p,'')))
$$;

-- Telefone brasileiro normalizado para E.164 sem '+': 55DDDNNNNNNNN
create or replace function private.norm_phone(p text)
returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p,''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if left(d,2) = '00' then d := substr(d,3); end if;
  if length(d) in (10,11) then d := '55' || d; end if;
  if length(d) < 12 or length(d) > 15 then return null; end if;
  return d;
end $$;

-- Placa: maiúscula sem separadores. Aceita antiga (ABC1234) e Mercosul (ABC1D23).
create or replace function private.norm_plate(p text)
returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p,''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

create type public.person_kind as enum ('pf','pj');

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  kind public.person_kind not null default 'pf',
  name text not null check (length(trim(name)) between 2 and 160),
  trade_name text,
  phone text,
  phone_norm text generated always as (private.norm_phone(phone)) stored,
  whatsapp text,
  whatsapp_norm text generated always as (private.norm_phone(coalesce(whatsapp, phone))) stored,
  email text,
  document text,
  document_norm text generated always as (nullif(regexp_replace(coalesce(document,''), '\D', '', 'g'), '')) stored,
  address jsonb not null default '{}'::jsonb,
  notes_internal text,
  preferred_channel text not null default 'whatsapp' check (preferred_channel in ('whatsapp','telefone','email','nenhum')),
  source text,
  responsible_membership_id uuid,
  merged_into uuid,
  archived_at timestamptz,
  search text generated always as (
    private.norm_text(name || ' ' || coalesce(trade_name,'') || ' ' || coalesce(phone,'') || ' ' ||
    coalesce(document,'') || ' ' || coalesce(email,''))) stored,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  foreign key (workshop_id, responsible_membership_id) references public.memberships(workshop_id, id),
  foreign key (workshop_id, merged_into) references public.clients(workshop_id, id)
);
create index clients_search_trgm on public.clients using gin (search extensions.gin_trgm_ops);
create index on public.clients(workshop_id, phone_norm);
create index on public.clients(workshop_id, document_norm);
create index on public.clients(workshop_id, name);
create trigger trg_clients_touch before update on public.clients
  for each row execute function private.touch_updated_at();
create trigger trg_audit_clients after insert or update on public.clients
  for each row execute function private.audit_row();

-- Consentimento/preferência por finalidade, com origem e data. O último
-- registro por (cliente, finalidade) é o vigente — histórico imutável.
create type public.contact_purpose as enum
  ('service_updates','appointment_reminders','maintenance_reminders','post_service','promotions');

create table public.contact_consents (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  client_id uuid not null,
  purpose public.contact_purpose not null,
  granted boolean not null,
  source text not null,  -- 'balcao','portal','mensagem','telefone','importacao'
  notes text,
  recorded_by uuid default auth.uid(),
  recorded_at timestamptz not null default now(),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id)
);
create index on public.contact_consents(client_id, purpose, recorded_at desc);

create or replace function public.client_consent(p_client uuid, p_purpose public.contact_purpose)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  -- Avisos de serviço são permitidos por padrão até a retirada;
  -- promoções exigem consentimento explícito.
  select coalesce(
    (select granted from public.contact_consents
      where client_id = p_client and purpose = p_purpose order by recorded_at desc, id desc limit 1),
    p_purpose <> 'promotions')
$$;

-- ---------------------------------------------------------------------
-- Veículos
-- ---------------------------------------------------------------------
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  plate text,
  plate_norm text generated always as (private.norm_plate(plate)) stored,
  plate_exception text,           -- justificativa: estrangeiro, sem registro...
  internal_code text,             -- identificador provisório sem placa
  brand text,
  model text not null,
  year_manufacture int check (year_manufacture between 1900 and 2100),
  year_model int check (year_model between 1900 and 2101),
  trim_version text,
  engine text,
  fuel text,
  transmission text,
  color text,
  vin text,
  notes text,
  archived_at timestamptz,
  search text generated always as (
    private.norm_text(coalesce(plate,'') || ' ' || coalesce(internal_code,'') || ' ' || coalesce(brand,'') || ' ' ||
    model || ' ' || coalesce(color,''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  check (plate_norm is not null or internal_code is not null),
  check (plate_norm is null or plate_exception is not null
         or plate_norm ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$')
);
create unique index vehicles_plate_unique on public.vehicles(workshop_id, plate_norm)
  where plate_norm is not null and archived_at is null;
create index vehicles_search_trgm on public.vehicles using gin (search extensions.gin_trgm_ops);
create trigger trg_vehicles_touch before update on public.vehicles
  for each row execute function private.touch_updated_at();
create trigger trg_audit_vehicles after insert or update on public.vehicles
  for each row execute function private.audit_row();

create or replace function private.vehicle_defaults()
returns trigger language plpgsql as $$
begin
  if new.plate_norm is null and private.norm_plate(new.plate) is null and new.internal_code is null then
    new.internal_code := private.next_number(new.workshop_id, 'vehicle_tmp');
  end if;
  return new;
end $$;
create trigger trg_vehicle_defaults before insert on public.vehicles
  for each row execute function private.vehicle_defaults();

-- Vínculo de propriedade com período. Mudança de dono encerra o vínculo
-- anterior: o histórico técnico do carro continua, mas dados pessoais e
-- financeiros do dono anterior não aparecem para o novo cliente.
create table public.vehicle_ownerships (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  vehicle_id uuid not null,
  client_id uuid not null,
  contact_client_id uuid,        -- responsável pelo contato quando diferente
  started_at date not null default current_date,
  ended_at date,
  end_reason text,
  created_at timestamptz not null default now(),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, contact_client_id) references public.clients(workshop_id, id)
);
create unique index one_current_owner on public.vehicle_ownerships(vehicle_id) where ended_at is null;
create index on public.vehicle_ownerships(client_id) where ended_at is null;
create trigger trg_audit_ownerships after insert or update on public.vehicle_ownerships
  for each row execute function private.audit_row();

create or replace function public.transfer_vehicle(p_vehicle uuid, p_new_client uuid, p_reason text,
                                                  p_contact_client uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.vehicles where id = p_vehicle;
  perform private.require_perm(v_ws, 'vehicles.edit');
  if not exists (select 1 from public.clients where id = p_new_client and workshop_id = v_ws) then
    raise exception 'Cliente não pertence a esta oficina';
  end if;
  update public.vehicle_ownerships set ended_at = current_date, end_reason = coalesce(p_reason,'transferência')
   where vehicle_id = p_vehicle and ended_at is null;
  insert into public.vehicle_ownerships(workshop_id, vehicle_id, client_id, contact_client_id)
  values (v_ws, p_vehicle, p_new_client, p_contact_client);
end $$;

-- ---------------------------------------------------------------------
-- Leituras de quilometragem (histórico; nunca apagadas)
-- ---------------------------------------------------------------------
create type public.km_source as enum ('order_entry','order_exit','reception','client_portal','client_message','manual','external');

create table public.odometer_readings (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  vehicle_id uuid not null,
  km int not null check (km >= 0 and km < 5000000),
  read_on date not null default current_date,
  source public.km_source not null,
  confirmed boolean not null default true,       -- leitura do cliente pode exigir validação
  regression_justification text,                  -- leitura menor que a anterior
  supersedes_id uuid references public.odometer_readings(id), -- correção / troca de painel
  invalidated_at timestamptz,
  invalidated_reason text,
  order_id uuid,
  recorded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id)
);
create index on public.odometer_readings(vehicle_id, read_on desc, created_at desc);
create trigger trg_audit_odometer after insert or update on public.odometer_readings
  for each row execute function private.audit_row();

-- Valida regressão: leitura inferior à última válida exige justificativa.
create or replace function private.check_odometer()
returns trigger language plpgsql as $$
declare last_km int;
begin
  select km into last_km from public.odometer_readings
   where vehicle_id = new.vehicle_id and invalidated_at is null and confirmed and id <> new.id
     and read_on <= new.read_on
   order by read_on desc, created_at desc limit 1;
  if last_km is not null and new.km < last_km and coalesce(trim(new.regression_justification),'') = '' then
    raise exception 'Quilometragem % é menor que a última leitura (% km). Informe a justificativa (correção, troca de painel...).',
      new.km, last_km using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger trg_check_odometer before insert on public.odometer_readings
  for each row execute function private.check_odometer();

-- Leituras são imutáveis exceto para invalidação/confirmação
create or replace function private.odometer_immutable()
returns trigger language plpgsql as $$
begin
  if new.km <> old.km or new.read_on <> old.read_on or new.vehicle_id <> old.vehicle_id then
    raise exception 'Leituras de km não podem ser editadas; registre uma correção';
  end if;
  return new;
end $$;
create trigger trg_odometer_immutable before update on public.odometer_readings
  for each row execute function private.odometer_immutable();

create or replace function public.vehicle_last_km(p_vehicle uuid)
returns table(km int, read_on date, source public.km_source)
language sql stable security definer set search_path = public, pg_temp as $$
  select km, read_on, source from public.odometer_readings
   where vehicle_id = p_vehicle and invalidated_at is null and confirmed
   order by read_on desc, created_at desc limit 1
$$;

-- Estimativa de km/dia: usa leituras confirmadas dos últimos 2 anos,
-- exige pelo menos duas datas distintas e rejeita taxas incoerentes.
create or replace function public.vehicle_km_rate(p_vehicle uuid)
returns table(km_per_day numeric, readings int, first_on date, last_on date, confidence text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r_first record; r_last record; n int; v_rate numeric; v_max numeric;
begin
  select coalesce((w.reminder_policy->>'max_km_per_day')::numeric, 1000) into v_max
    from public.vehicles v join public.workshops w on w.id = v.workshop_id where v.id = p_vehicle;
  select count(distinct read_on) into n from public.odometer_readings
   where vehicle_id = p_vehicle and invalidated_at is null and confirmed and read_on > current_date - 730;
  if n < 2 then return; end if;
  select km, read_on into r_first from public.odometer_readings
   where vehicle_id = p_vehicle and invalidated_at is null and confirmed and read_on > current_date - 730
     and regression_justification is null
   order by read_on asc, created_at asc limit 1;
  select km, read_on into r_last from public.odometer_readings
   where vehicle_id = p_vehicle and invalidated_at is null and confirmed and read_on > current_date - 730
   order by read_on desc, created_at desc limit 1;
  if r_last.read_on = r_first.read_on or r_last.km < r_first.km then return; end if;
  v_rate := (r_last.km - r_first.km)::numeric / (r_last.read_on - r_first.read_on);
  if v_rate <= 0 or v_rate > v_max then return; end if;
  return query select round(v_rate, 2), n, r_first.read_on, r_last.read_on,
    case when n >= 4 and (r_last.read_on - r_first.read_on) >= 180 then 'alta'
         when (r_last.read_on - r_first.read_on) >= 60 then 'media' else 'baixa' end;
end $$;

-- ---------------------------------------------------------------------
-- Detecção de duplicidade (não bloqueia: famílias compartilham telefone)
-- ---------------------------------------------------------------------
create or replace function public.client_possible_duplicates(p_workshop uuid, p_phone text, p_document text,
                                                            p_exclude uuid default null)
returns table(id uuid, name text, phone text, document text, reason text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.name, c.phone, c.document,
         case when c.document_norm is not null and c.document_norm = nullif(regexp_replace(coalesce(p_document,''),'\D','','g'),'')
              then 'mesmo documento' else 'mesmo telefone' end
    from public.clients c
   where private.has_perm(p_workshop, 'clients.view')
     and c.workshop_id = p_workshop and c.archived_at is null and c.merged_into is null
     and (p_exclude is null or c.id <> p_exclude)
     and ((c.phone_norm is not null and c.phone_norm = private.norm_phone(p_phone))
       or (c.document_norm is not null and c.document_norm = nullif(regexp_replace(coalesce(p_document,''),'\D','','g'),'')))
   limit 10
$$;

-- Fusão revisada: move vínculos do duplicado para o principal e arquiva-o.
create or replace function public.merge_clients(p_keep uuid, p_merge uuid, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.clients where id = p_keep;
  perform private.require_perm(v_ws, 'clients.merge');
  if p_keep = p_merge or not exists (select 1 from public.clients where id = p_merge and workshop_id = v_ws) then
    raise exception 'Cadastros inválidos para fusão';
  end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'Informe o motivo da fusão'; end if;
  update public.vehicle_ownerships set client_id = p_keep where client_id = p_merge;
  update public.contact_consents set client_id = p_keep where client_id = p_merge;
  update public.clients set merged_into = p_keep, archived_at = now() where id = p_merge;
  perform private.audit(v_ws, 'merge', 'clients', p_keep::text, jsonb_build_object('mesclado', p_merge, 'motivo', p_note));
end $$;

-- Cadastro rápido no balcão: cliente + veículo (+ km) numa transação
create or replace function public.quick_register(p_workshop uuid, p_client jsonb, p_vehicle jsonb, p_km int default null)
returns table(client_id uuid, vehicle_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_c uuid; v_v uuid;
begin
  perform private.require_perm(p_workshop, 'clients.create');
  perform private.require_perm(p_workshop, 'vehicles.create');
  if p_client ? 'id' and nullif(p_client->>'id','') is not null then
    select id into v_c from public.clients where id = (p_client->>'id')::uuid and workshop_id = p_workshop;
    if v_c is null then raise exception 'Cliente não encontrado'; end if;
  else
    insert into public.clients(workshop_id, kind, name, phone, whatsapp, email, document)
    values (p_workshop, coalesce((p_client->>'kind')::public.person_kind,'pf'), p_client->>'name',
            nullif(p_client->>'phone',''), nullif(p_client->>'whatsapp',''), nullif(p_client->>'email',''),
            nullif(p_client->>'document',''))
    returning id into v_c;
  end if;
  if p_vehicle is not null and p_vehicle <> 'null'::jsonb then
    insert into public.vehicles(workshop_id, plate, plate_exception, brand, model, year_model, color, fuel)
    values (p_workshop, nullif(p_vehicle->>'plate',''), nullif(p_vehicle->>'plate_exception',''),
            nullif(p_vehicle->>'brand',''), p_vehicle->>'model', nullif(p_vehicle->>'year_model','')::int,
            nullif(p_vehicle->>'color',''), nullif(p_vehicle->>'fuel',''))
    returning id into v_v;
    insert into public.vehicle_ownerships(workshop_id, vehicle_id, client_id) values (p_workshop, v_v, v_c);
    if p_km is not null then
      insert into public.odometer_readings(workshop_id, vehicle_id, km, source) values (p_workshop, v_v, p_km, 'reception');
    end if;
  end if;
  return query select v_c, v_v;
end $$;

-- Busca unificada do balcão: placa, nome, telefone (OS entra na migração de OS)
create or replace function public.search_clients_vehicles(p_workshop uuid, p_q text, p_limit int default 20)
returns table(kind text, id uuid, title text, subtitle text, client_id uuid, vehicle_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with q as (select private.norm_text(trim(p_q)) t, private.norm_plate(p_q) p,
                    nullif(regexp_replace(p_q,'\D','','g'),'') d)
  select * from (
    select 'vehicle'::text, v.id, coalesce(v.plate, v.internal_code) || ' — ' || coalesce(v.brand || ' ','') || v.model,
           coalesce(c.name, 'sem proprietário'), c.id, v.id
      from public.vehicles v, q
      left join lateral (select cl.id, cl.name from public.vehicle_ownerships o join public.clients cl on cl.id = o.client_id
                          where o.vehicle_id = v.id and o.ended_at is null limit 1) c on true
     where v.workshop_id = p_workshop and v.archived_at is null and private.has_perm(p_workshop, 'vehicles.view')
       and (v.plate_norm like q.p || '%' or v.search like '%' || q.t || '%')
    union all
    select 'client', c.id, c.name, coalesce(c.phone, c.email, ''), c.id, null
      from public.clients c, q
     where c.workshop_id = p_workshop and c.archived_at is null and c.merged_into is null
       and private.has_perm(p_workshop, 'clients.view')
       and (c.search like '%' || q.t || '%' or (q.d is not null and length(q.d) >= 4 and c.phone_norm like '%' || q.d || '%'))
  ) r limit p_limit
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.clients enable row level security;
alter table public.contact_consents enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_ownerships enable row level security;
alter table public.odometer_readings enable row level security;

create policy cli_select on public.clients for select to authenticated using (private.has_perm(workshop_id,'clients.view'));
create policy cli_insert on public.clients for insert to authenticated with check (private.has_perm(workshop_id,'clients.create'));
create policy cli_update on public.clients for update to authenticated
  using (private.has_perm(workshop_id,'clients.edit')) with check (private.has_perm(workshop_id,'clients.edit'));

create policy cons_select on public.contact_consents for select to authenticated
  using (private.has_perm(workshop_id,'clients.view') or private.has_perm(workshop_id,'contacts.view'));
create policy cons_insert on public.contact_consents for insert to authenticated
  with check (private.has_perm(workshop_id,'clients.edit') or private.has_perm(workshop_id,'contacts.edit'));

create policy veh_select on public.vehicles for select to authenticated using (private.has_perm(workshop_id,'vehicles.view'));
create policy veh_insert on public.vehicles for insert to authenticated with check (private.has_perm(workshop_id,'vehicles.create'));
create policy veh_update on public.vehicles for update to authenticated
  using (private.has_perm(workshop_id,'vehicles.edit')) with check (private.has_perm(workshop_id,'vehicles.edit'));

create policy own_select on public.vehicle_ownerships for select to authenticated
  using (private.has_perm(workshop_id,'vehicles.view') and private.has_perm(workshop_id,'clients.view'));
create policy own_insert on public.vehicle_ownerships for insert to authenticated
  with check (private.has_perm(workshop_id,'vehicles.create') or private.has_perm(workshop_id,'vehicles.edit'));

create policy odo_select on public.odometer_readings for select to authenticated using (private.has_perm(workshop_id,'vehicles.view'));
create policy odo_insert on public.odometer_readings for insert to authenticated
  with check (private.has_perm(workshop_id,'vehicles.edit') or private.has_perm(workshop_id,'vehicles.create')
              or private.has_perm(workshop_id,'orders.execute'));
create policy odo_update on public.odometer_readings for update to authenticated
  using (private.has_perm(workshop_id,'vehicles.edit')) with check (private.has_perm(workshop_id,'vehicles.edit'));
