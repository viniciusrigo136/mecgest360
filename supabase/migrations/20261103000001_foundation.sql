-- =====================================================================
-- MecGest 360 — Fase 1: Fundação
-- Oficinas, perfis, equipe, permissões granulares, convites e auditoria.
-- Regra geral: negar por padrão. Toda tabela de oficina tem RLS e
-- toda verificação consulta a associação ATIVA no banco (não o JWT).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, anon, service_role;

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and to_jsonb(new) ? 'version' then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

create or replace function private.sha256_hex(p text)
returns text language sql immutable as $$
  select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex')
$$;

-- Token aleatório de alta entropia (256 bits) em base64url.
create or replace function private.random_token()
returns text language sql volatile as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')
$$;

-- ---------------------------------------------------------------------
-- Oficinas
-- ---------------------------------------------------------------------
create table public.workshops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  legal_name text,
  document text,
  phone text,
  whatsapp text,
  email text,
  address jsonb not null default '{}'::jsonb,
  logo_path text,
  primary_color text not null default '#1d4ed8' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  timezone text not null default 'America/Sao_Paulo',
  business_hours jsonb not null default '{
    "1":[["08:00","12:00"],["13:00","18:00"]],
    "2":[["08:00","12:00"],["13:00","18:00"]],
    "3":[["08:00","12:00"],["13:00","18:00"]],
    "4":[["08:00","12:00"],["13:00","18:00"]],
    "5":[["08:00","12:00"],["13:00","18:00"]],
    "6":[["08:00","12:00"]],
    "0":[]
  }'::jsonb,
  payment_methods jsonb not null default '["dinheiro","pix","cartao_debito","cartao_credito","transferencia"]'::jsonb,
  commercial_terms text,
  warranty_terms text,
  max_discount_pct numeric(5,2) not null default 10 check (max_discount_pct between 0 and 100),
  reminder_policy jsonb not null default '{
    "window_start":"09:00","window_end":"18:00","business_days_only":true,
    "max_auto_contacts_per_cycle":2,"min_days_between_contacts":7,
    "default_lead_days":15,"km_estimates_enabled":true,"max_km_per_day":1000
  }'::jsonb,
  messaging_mode text not null default 'manual' check (messaging_mode in ('manual','automatic')),
  is_demo boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create trigger trg_workshops_touch before update on public.workshops
  for each row execute function private.touch_updated_at();

-- Numeração sequencial por oficina (OS, orçamentos, compras, recibos...)
create table public.workshop_counters (
  workshop_id uuid not null references public.workshops(id),
  kind text not null,
  prefix text not null default '',
  next_value bigint not null default 1,
  primary key (workshop_id, kind)
);

create or replace function private.next_number(p_workshop uuid, p_kind text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint; pfx text;
begin
  insert into public.workshop_counters(workshop_id, kind) values (p_workshop, p_kind)
  on conflict do nothing;
  update public.workshop_counters set next_value = next_value + 1
   where workshop_id = p_workshop and kind = p_kind
   returning next_value - 1, prefix into v, pfx;
  return pfx || lpad(v::text, 5, '0');
end $$;

-- ---------------------------------------------------------------------
-- Perfis de usuário (1:1 com auth.users)
-- ---------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(user_id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), lower(new.email))
  on conflict (user_id) do update set email = excluded.email;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
create type public.member_role as enum
  ('owner','manager','reception','mechanic','finance','stock','viewer');
create type public.member_status as enum ('active','blocked');
create type public.record_scope as enum ('assigned','all');

create table public.permissions (
  key text primary key,
  module text not null,
  label text not null,
  sensitive boolean not null default false
);

insert into public.permissions(key, module, label, sensitive) values
 ('dashboard.view','Visão geral','Ver painel',false),
 ('clients.view','Clientes','Ver clientes',false),
 ('clients.create','Clientes','Criar clientes',false),
 ('clients.edit','Clientes','Editar clientes',false),
 ('clients.archive','Clientes','Arquivar clientes',false),
 ('clients.merge','Clientes','Mesclar cadastros duplicados',true),
 ('clients.export','Clientes','Exportar clientes',true),
 ('vehicles.view','Veículos','Ver veículos',false),
 ('vehicles.create','Veículos','Criar veículos',false),
 ('vehicles.edit','Veículos','Editar veículos e transferir proprietário',false),
 ('vehicles.archive','Veículos','Arquivar veículos',false),
 ('schedule.view','Agenda','Ver agenda',false),
 ('schedule.create','Agenda','Criar agendamentos',false),
 ('schedule.edit','Agenda','Editar/reagendar',false),
 ('schedule.cancel','Agenda','Cancelar agendamentos',false),
 ('schedule.override','Agenda','Forçar horário com conflito (com justificativa)',true),
 ('orders.view','Ordens de serviço','Ver OS (conforme escopo)',false),
 ('orders.view_all','Ordens de serviço','Ver todas as OS da oficina',false),
 ('orders.create','Ordens de serviço','Abrir OS',false),
 ('orders.edit','Ordens de serviço','Editar OS e itens',false),
 ('orders.execute','Ordens de serviço','Executar: tarefas, checklist, fotos, diagnóstico, tempo',false),
 ('orders.assign','Ordens de serviço','Alterar atribuições',false),
 ('orders.cancel','Ordens de serviço','Cancelar OS',false),
 ('orders.deliver','Ordens de serviço','Registrar entrega',false),
 ('orders.reopen','Ordens de serviço','Reabrir OS',true),
 ('orders.print','Ordens de serviço','Imprimir OS',false),
 ('quotes.view','Orçamentos','Ver orçamentos',false),
 ('quotes.create','Orçamentos','Criar/editar orçamentos',false),
 ('quotes.send','Orçamentos','Enviar orçamentos',false),
 ('quotes.approve_onsite','Orçamentos','Registrar aprovação presencial/telefone',false),
 ('prices.view','Valores','Ver preços comerciais',false),
 ('costs.view','Valores','Ver custos',true),
 ('margins.view','Valores','Ver margens',true),
 ('discount.above_limit','Valores','Conceder desconto acima do limite',true),
 ('maintenance.view','Preventiva','Ver planos preventivos',false),
 ('maintenance.edit','Preventiva','Criar/editar planos e ciclos',false),
 ('contacts.view','Contatos','Ver tarefas de contato e retornos',false),
 ('contacts.edit','Contatos','Registrar contatos e respostas',false),
 ('messages.send','Contatos','Enviar mensagens',false),
 ('inventory.view','Estoque','Ver estoque',false),
 ('inventory.edit','Estoque','Cadastrar peças, reservar e consumir',false),
 ('inventory.adjust','Estoque','Ajustar estoque / inventário',true),
 ('inventory.negative','Estoque','Permitir saldo negativo (exceção)',true),
 ('purchasing.view','Compras','Ver compras e fornecedores',false),
 ('purchasing.edit','Compras','Criar pedidos e fornecedores',false),
 ('purchasing.receive','Compras','Registrar recebimentos',false),
 ('finance.view','Financeiro','Ver contas a pagar/receber',true),
 ('finance.edit','Financeiro','Lançar contas',true),
 ('payments.receive','Financeiro','Receber pagamentos',true),
 ('payments.refund','Financeiro','Estornar pagamentos',true),
 ('cash.operate','Financeiro','Abrir/fechar caixa',true),
 ('commissions.view_own','Financeiro','Ver as próprias comissões',false),
 ('commissions.manage','Financeiro','Gerenciar comissões',true),
 ('reports.view','Relatórios','Ver relatórios operacionais',false),
 ('reports.financial','Relatórios','Ver relatórios financeiros',true),
 ('reports.export','Relatórios','Exportar CSV/PDF',true),
 ('team.view','Equipe','Ver equipe',false),
 ('team.manage','Equipe','Convidar, bloquear e alterar permissões',true),
 ('settings.manage','Configurações','Alterar configurações da oficina',true),
 ('integrations.manage','Configurações','Gerenciar integrações',true),
 ('audit.view','Configurações','Ver auditoria',true);

-- Matriz padrão por perfil (o proprietário tem todas implicitamente).
create table public.role_default_permissions (
  role public.member_role not null,
  permission text not null references public.permissions(key),
  primary key (role, permission)
);

insert into public.role_default_permissions(role, permission)
select 'manager'::public.member_role, key from public.permissions
 where key not in ('finance.view','finance.edit','payments.receive','payments.refund','cash.operate',
                   'reports.financial','team.manage','integrations.manage','settings.manage',
                   'commissions.manage','inventory.negative','margins.view','audit.view','clients.export',
                   'reports.export','clients.merge')
union all
select 'reception'::public.member_role, unnest(array[
  'dashboard.view','clients.view','clients.create','clients.edit','vehicles.view','vehicles.create',
  'vehicles.edit','schedule.view','schedule.create','schedule.edit','schedule.cancel',
  'orders.view','orders.view_all','orders.create','orders.edit','orders.deliver','orders.print',
  'quotes.view','quotes.create','quotes.send','quotes.approve_onsite','prices.view',
  'maintenance.view','contacts.view','contacts.edit','messages.send','team.view'])
union all
select 'mechanic'::public.member_role, unnest(array['dashboard.view','orders.view','orders.execute','maintenance.view'])
union all
select 'finance'::public.member_role, unnest(array[
  'dashboard.view','finance.view','finance.edit','payments.receive','payments.refund','cash.operate',
  'prices.view','reports.view','reports.financial','commissions.manage','orders.view','orders.view_all'])
union all
select 'stock'::public.member_role, unnest(array[
  'dashboard.view','inventory.view','inventory.edit','inventory.adjust','purchasing.view',
  'purchasing.edit','purchasing.receive','costs.view','orders.view','orders.view_all'])
union all
select 'viewer'::public.member_role, unnest(array['dashboard.view','clients.view','vehicles.view','schedule.view',
  'orders.view','orders.view_all']);

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  user_id uuid not null references auth.users(id),
  role public.member_role not null,
  status public.member_status not null default 'active',
  job_title text,
  order_scope public.record_scope not null default 'all',
  specialties text[] not null default '{}',
  availability jsonb not null default '{}'::jsonb,
  color text,
  blocked_at timestamptz,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, user_id),
  unique (workshop_id, id)
);
create index on public.memberships(user_id) where status = 'active';
create trigger trg_memberships_touch before update on public.memberships
  for each row execute function private.touch_updated_at();

-- Ajustes individuais sobre o perfil (conceder ou negar)
create table public.member_permission_overrides (
  workshop_id uuid not null,
  membership_id uuid not null,
  permission text not null references public.permissions(key),
  granted boolean not null,
  primary key (membership_id, permission),
  foreign key (workshop_id, membership_id) references public.memberships(workshop_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Funções de autorização (consultam o banco a cada chamada)
-- ---------------------------------------------------------------------
create or replace function private.active_membership(p_workshop uuid)
returns public.memberships
language sql stable security definer set search_path = public, pg_temp as $$
  select m.* from public.memberships m
   join public.workshops w on w.id = m.workshop_id and w.archived_at is null
   where m.workshop_id = p_workshop and m.user_id = auth.uid() and m.status = 'active'
$$;

create or replace function private.is_member(p_workshop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
     join public.workshops w on w.id = m.workshop_id and w.archived_at is null
    where m.workshop_id = p_workshop and m.user_id = auth.uid() and m.status = 'active')
$$;

create or replace function private.member_has_perm(p_membership uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when m.status <> 'active' then false
    when m.role = 'owner' then true
    else coalesce(
      (select o.granted from public.member_permission_overrides o
        where o.membership_id = m.id and o.permission = p_perm),
      exists (select 1 from public.role_default_permissions r
               where r.role = m.role and r.permission = p_perm))
  end
  from public.memberships m where m.id = p_membership
$$;

create or replace function private.has_perm(p_workshop uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select private.member_has_perm(m.id, p_perm)
      from public.memberships m
      join public.workshops w on w.id = m.workshop_id and w.archived_at is null
     where m.workshop_id = p_workshop and m.user_id = auth.uid() and m.status = 'active'), false)
$$;

-- Lança exceção padronizada quando a permissão falta
create or replace function private.require_perm(p_workshop uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not private.has_perm(p_workshop, p_perm) then
    raise exception 'Sem permissão: %', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function private.current_membership_id(p_workshop uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.memberships
   where workshop_id = p_workshop and user_id = auth.uid() and status = 'active'
$$;

-- Lista efetiva de permissões do usuário (para o frontend adaptar menus)
create or replace function public.my_permissions(p_workshop uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(p.key order by p.key), '{}')
    from public.permissions p
   where private.has_perm(p_workshop, p.key)
$$;

create or replace function public.my_workshops()
returns table(workshop_id uuid, name text, role public.member_role, primary_color text,
              logo_path text, timezone text, is_demo boolean, membership_id uuid, order_scope public.record_scope)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.id, w.name, m.role, w.primary_color, w.logo_path, w.timezone, w.is_demo, m.id, m.order_scope
    from public.memberships m join public.workshops w on w.id = m.workshop_id
   where m.user_id = auth.uid() and m.status = 'active' and w.archived_at is null
   order by w.name
$$;

-- Prévia textual do acesso resultante (antes de salvar perfil)
create or replace function public.preview_access(p_role public.member_role, p_overrides jsonb)
returns table(module text, label text, permission text, granted boolean, sensitive boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.module, p.label, p.key,
    case when p_role = 'owner' then true
         when p_overrides ? p.key then (p_overrides->>p.key)::boolean
         else exists (select 1 from public.role_default_permissions r where r.role = p_role and r.permission = p.key)
    end, p.sensitive
  from public.permissions p order by p.module, p.key
$$;

-- ---------------------------------------------------------------------
-- Auditoria
-- ---------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  workshop_id uuid references public.workshops(id),
  actor_id uuid,
  action text not null,
  resource text not null,
  resource_id text,
  changes jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_log(workshop_id, created_at desc);
create index on public.audit_log(workshop_id, resource, resource_id);

-- Campos que nunca entram na auditoria
create or replace function private.audit_strip(j jsonb)
returns jsonb language sql immutable as $$
  select j - 'token_hash' - 'code_hash' - 'password' - 'updated_at' - 'version' - 'search'
$$;

create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb; v_new jsonb; v_diff jsonb := '{}'::jsonb; k text; v_ws uuid; v_id text;
begin
  if tg_op in ('UPDATE','DELETE') then v_old := private.audit_strip(to_jsonb(old)); end if;
  if tg_op in ('INSERT','UPDATE') then v_new := private.audit_strip(to_jsonb(new)); end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if v_new->k is distinct from v_old->k then
        v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('de', v_old->k, 'para', v_new->k));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then return new; end if;
  elsif tg_op = 'INSERT' then v_diff := v_new;
  else v_diff := v_old; end if;
  v_ws := coalesce((v_new->>'workshop_id')::uuid, (v_old->>'workshop_id')::uuid,
                   case when tg_table_name = 'workshops' then coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid) end);
  v_id := coalesce(v_new->>'id', v_old->>'id', v_new->>'membership_id', v_old->>'membership_id');
  insert into public.audit_log(workshop_id, actor_id, action, resource, resource_id, changes)
  values (v_ws, auth.uid(), lower(tg_op), tg_table_name, v_id, v_diff);
  return coalesce(new, old);
end $$;

create or replace function private.audit(p_workshop uuid, p_action text, p_resource text,
                                         p_resource_id text, p_changes jsonb default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log(workshop_id, actor_id, action, resource, resource_id, changes)
  values (p_workshop, auth.uid(), p_action, p_resource, p_resource_id, p_changes)
$$;

create trigger trg_audit_workshops after update on public.workshops
  for each row execute function private.audit_row();
create trigger trg_audit_memberships after insert or update or delete on public.memberships
  for each row execute function private.audit_row();
create trigger trg_audit_overrides after insert or update or delete on public.member_permission_overrides
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- Proteções de equipe
-- ---------------------------------------------------------------------
create or replace function private.guard_last_owner()
returns trigger language plpgsql as $$
declare remaining int;
begin
  if (tg_op = 'DELETE' and old.role = 'owner' and old.status = 'active')
     or (tg_op = 'UPDATE' and old.role = 'owner' and old.status = 'active'
         and (new.role <> 'owner' or new.status <> 'active')) then
    select count(*) into remaining from public.memberships
     where workshop_id = old.workshop_id and role = 'owner' and status = 'active' and id <> old.id;
    if remaining = 0 then
      raise exception 'Não é possível remover ou bloquear o último proprietário da oficina'
        using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_last_owner before update or delete on public.memberships
  for each row execute function private.guard_last_owner();

-- ---------------------------------------------------------------------
-- Convites
-- ---------------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  email text not null,
  full_name text not null,
  role public.member_role not null,
  job_title text,
  order_scope public.record_scope not null default 'all',
  overrides jsonb not null default '{}'::jsonb,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id),
  revoked_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on public.invites(workshop_id, lower(email)) where used_at is null and revoked_at is null;
create trigger trg_audit_invites after insert or update on public.invites
  for each row execute function private.audit_row();

-- Impede escalada: quem concede precisa ter a permissão concedida; só
-- proprietário cria/promove proprietário; ninguém altera a si mesmo.
create or replace function private.assert_can_grant(p_workshop uuid, p_role public.member_role, p_overrides jsonb)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.memberships; k text;
begin
  me := private.active_membership(p_workshop);
  if me.id is null then raise exception 'Sem acesso à oficina' using errcode = '42501'; end if;
  if not private.member_has_perm(me.id, 'team.manage') then
    raise exception 'Sem permissão: team.manage' using errcode = '42501';
  end if;
  if p_role = 'owner' and me.role <> 'owner' then
    raise exception 'Somente proprietário concede perfil de proprietário' using errcode = '42501';
  end if;
  if me.role <> 'owner' then
    -- defaults do perfil + overrides concedidos não podem exceder o que o gestor tem
    for k in
      select r.permission from public.role_default_permissions r where r.role = p_role
       and not (coalesce(p_overrides,'{}'::jsonb) ? r.permission and (p_overrides->>r.permission)::boolean = false)
      union
      select key from jsonb_each_text(coalesce(p_overrides,'{}'::jsonb)) where value::boolean
    loop
      if not private.member_has_perm(me.id, k) then
        raise exception 'Você não pode conceder uma permissão que não possui: %', k using errcode = '42501';
      end if;
    end loop;
  end if;
end $$;

-- Cria convite e devolve o token em claro UMA vez (o banco guarda só o hash).
-- Convites pendentes anteriores para o mesmo e-mail são revogados.
create or replace function public.create_invite(
  p_workshop uuid, p_email text, p_full_name text, p_role public.member_role,
  p_job_title text default null, p_order_scope public.record_scope default 'all',
  p_overrides jsonb default '{}'::jsonb, p_valid_hours int default 72)
returns table(invite_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token text := private.random_token(); v_id uuid; v_exp timestamptz;
begin
  perform private.assert_can_grant(p_workshop, p_role, p_overrides);
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido'; end if;
  if exists (select 1 from public.memberships m join public.profiles pr on pr.user_id = m.user_id
              where m.workshop_id = p_workshop and pr.email = lower(trim(p_email))) then
    raise exception 'Esta pessoa já faz parte da equipe';
  end if;
  update public.invites set revoked_at = now()
   where workshop_id = p_workshop and lower(email) = lower(trim(p_email))
     and used_at is null and revoked_at is null;
  v_exp := now() + make_interval(hours => least(greatest(p_valid_hours, 1), 168));
  insert into public.invites(workshop_id, email, full_name, role, job_title, order_scope, overrides,
                             token_hash, expires_at, created_by)
  values (p_workshop, lower(trim(p_email)), trim(p_full_name), p_role, p_job_title, p_order_scope,
          coalesce(p_overrides,'{}'::jsonb), private.sha256_hex(v_token), v_exp, auth.uid())
  returning id into v_id;
  return query select v_id, v_token, v_exp;
end $$;

create or replace function public.revoke_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.invites where id = p_invite;
  perform private.require_perm(v_ws, 'team.manage');
  update public.invites set revoked_at = now() where id = p_invite and used_at is null and revoked_at is null;
end $$;

-- Consulta pública mínima do convite (para a tela de aceite)
create or replace function public.invite_info(p_token text)
returns table(workshop_name text, full_name text, email text, role public.member_role, valid boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.name, i.full_name, i.email, i.role,
         (i.used_at is null and i.revoked_at is null and i.expires_at > now())
    from public.invites i join public.workshops w on w.id = i.workshop_id
   where i.token_hash = private.sha256_hex(p_token)
$$;

create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.invites; v_email text; v_mid uuid; k text; v bool;
begin
  if auth.uid() is null then raise exception 'Faça login para aceitar o convite' using errcode = '42501'; end if;
  select * into inv from public.invites where token_hash = private.sha256_hex(p_token) for update;
  if inv.id is null or inv.used_at is not null or inv.revoked_at is not null or inv.expires_at <= now() then
    raise exception 'Convite inválido, expirado ou já utilizado';
  end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is distinct from lower(inv.email) then
    raise exception 'Este convite foi emitido para outro e-mail';
  end if;
  insert into public.memberships(workshop_id, user_id, role, job_title, order_scope)
  values (inv.workshop_id, auth.uid(), inv.role, inv.job_title, inv.order_scope)
  returning id into v_mid;
  for k, v in select key, value::boolean from jsonb_each_text(inv.overrides) loop
    insert into public.member_permission_overrides(workshop_id, membership_id, permission, granted)
    values (inv.workshop_id, v_mid, k, v);
  end loop;
  update public.profiles set full_name = coalesce(nullif(full_name,''), inv.full_name) where user_id = auth.uid();
  update public.invites set used_at = now(), used_by = auth.uid() where id = inv.id;
  return inv.workshop_id;
end $$;

-- Alteração de perfil/permissões de um membro
create or replace function public.update_member(
  p_membership uuid, p_role public.member_role, p_order_scope public.record_scope,
  p_overrides jsonb, p_job_title text default null, p_expected_version int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare tgt public.memberships; k text; v bool;
begin
  select * into tgt from public.memberships where id = p_membership for update;
  if tgt.id is null then raise exception 'Membro não encontrado'; end if;
  if tgt.user_id = auth.uid() then
    raise exception 'Você não pode alterar o próprio perfil ou permissões' using errcode = '42501';
  end if;
  if p_expected_version is not null and tgt.version <> p_expected_version then
    raise exception 'Registro alterado por outra pessoa. Recarregue.' using errcode = '40001';
  end if;
  perform private.assert_can_grant(tgt.workshop_id, p_role, p_overrides);
  if tgt.role = 'owner' and (private.active_membership(tgt.workshop_id)).role <> 'owner' then
    raise exception 'Somente proprietário altera outro proprietário' using errcode = '42501';
  end if;
  update public.memberships set role = p_role, order_scope = p_order_scope,
         job_title = coalesce(p_job_title, job_title) where id = p_membership;
  delete from public.member_permission_overrides where membership_id = p_membership;
  for k, v in select key, value::boolean from jsonb_each_text(coalesce(p_overrides,'{}'::jsonb)) loop
    insert into public.member_permission_overrides(workshop_id, membership_id, permission, granted)
    values (tgt.workshop_id, p_membership, k, v);
  end loop;
end $$;

create or replace function public.set_member_status(p_membership uuid, p_status public.member_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare tgt public.memberships;
begin
  select * into tgt from public.memberships where id = p_membership for update;
  if tgt.id is null then raise exception 'Membro não encontrado'; end if;
  if tgt.user_id = auth.uid() then raise exception 'Você não pode bloquear a si mesmo' using errcode = '42501'; end if;
  perform private.require_perm(tgt.workshop_id, 'team.manage');
  if tgt.role = 'owner' and (private.active_membership(tgt.workshop_id)).role <> 'owner' then
    raise exception 'Somente proprietário bloqueia outro proprietário' using errcode = '42501';
  end if;
  update public.memberships set status = p_status,
     blocked_at = case when p_status = 'blocked' then now() end,
     blocked_reason = case when p_status = 'blocked' then p_reason end
   where id = p_membership;
end $$;

create or replace function public.update_member_profile(
  p_membership uuid, p_specialties text[], p_availability jsonb, p_color text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  select workshop_id into v_ws from public.memberships where id = p_membership;
  perform private.require_perm(v_ws, 'team.manage');
  update public.memberships set specialties = coalesce(p_specialties,'{}'),
         availability = coalesce(p_availability,'{}'::jsonb), color = p_color
   where id = p_membership;
end $$;

-- ---------------------------------------------------------------------
-- Provisionamento controlado (somente service_role / CLI)
-- ---------------------------------------------------------------------
create or replace function public.provision_workshop(p_name text, p_owner_user uuid, p_is_demo boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  insert into public.workshops(name, is_demo) values (p_name, p_is_demo) returning id into v_ws;
  insert into public.memberships(workshop_id, user_id, role) values (v_ws, p_owner_user, 'owner');
  insert into public.workshop_counters(workshop_id, kind, prefix) values
    (v_ws,'order','OS-'),(v_ws,'quote','ORC-'),(v_ws,'purchase','PC-'),(v_ws,'receipt','REC-'),
    (v_ws,'vehicle_tmp','TMP-');
  return v_ws;
end $$;
revoke execute on function public.provision_workshop(text, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.workshops enable row level security;
alter table public.workshop_counters enable row level security;
alter table public.profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_default_permissions enable row level security;
alter table public.memberships enable row level security;
alter table public.member_permission_overrides enable row level security;
alter table public.audit_log enable row level security;
alter table public.invites enable row level security;

create policy ws_select on public.workshops for select to authenticated using (private.is_member(id));
create policy ws_update on public.workshops for update to authenticated
  using (private.has_perm(id, 'settings.manage')) with check (private.has_perm(id, 'settings.manage'));

create policy perm_read on public.permissions for select to authenticated using (true);
create policy rdp_read on public.role_default_permissions for select to authenticated using (true);

create policy prof_self on public.profiles for select to authenticated using (user_id = auth.uid());
create policy prof_team on public.profiles for select to authenticated using (
  exists (select 1 from public.memberships m where m.user_id = profiles.user_id
           and private.is_member(m.workshop_id)));
create policy prof_update_self on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Todos os membros ativos enxergam a lista básica da equipe (para atribuição);
-- alterações somente via RPC.
create policy mem_select on public.memberships for select to authenticated
  using (private.is_member(workshop_id));
create policy mpo_select on public.member_permission_overrides for select to authenticated
  using (private.has_perm(workshop_id, 'team.view') or
         membership_id = private.current_membership_id(workshop_id));

create policy inv_select on public.invites for select to authenticated
  using (private.has_perm(workshop_id, 'team.manage'));

create policy audit_select on public.audit_log for select to authenticated
  using (private.has_perm(workshop_id, 'audit.view'));

grant execute on all functions in schema private to authenticated, anon;
