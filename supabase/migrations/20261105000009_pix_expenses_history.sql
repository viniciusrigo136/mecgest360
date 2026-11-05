-- =====================================================================
-- Pix da oficina, gastos do serviço (quanto sobrou) e histórico do carro
-- no portal do cliente.
-- =====================================================================

alter table public.workshops
  add column if not exists pix_key text,
  add column if not exists pix_name text,
  add column if not exists pix_city text;

-- ---------------------------------------------------------------------
-- Gastos do serviço: o que a oficina gastou (peças, terceiros, material)
-- Visível só para quem vê custos; nunca aparece para o cliente.
-- ---------------------------------------------------------------------
create table public.order_expenses (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  order_id uuid not null,
  description text not null check (length(trim(description)) between 2 and 200),
  category text not null default 'peca' check (category in ('peca','terceiro','material','outro')),
  amount_cents bigint not null check (amount_cents > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, order_id) references public.service_orders(workshop_id, id)
);
create index on public.order_expenses(order_id);
create trigger trg_audit_expenses after insert or update or delete on public.order_expenses
  for each row execute function private.audit_row();

alter table public.order_expenses enable row level security;
create policy oe_select on public.order_expenses for select to authenticated
  using (private.has_perm(workshop_id, 'costs.view') and private.can_see_order(order_id));
create policy oe_insert on public.order_expenses for insert to authenticated
  with check (private.has_perm(workshop_id, 'costs.view') and private.can_see_order(order_id) and created_by = auth.uid());
create policy oe_delete on public.order_expenses for delete to authenticated
  using (private.has_perm(workshop_id, 'costs.view') and private.can_see_order(order_id));
grant select, insert, delete on public.order_expenses to authenticated;

-- Resumo financeiro do serviço: total, gastos anotados e sobra.
create or replace function public.order_profit(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_total bigint; v_exp bigint; v_items_cost bigint;
begin
  o := private.require_order(p_order, 'costs.view');
  select coalesce(sum(total_cents),0) into v_total from public.order_items where order_id = p_order and status in ('approved','in_progress','done');
  select coalesce(sum(amount_cents),0) into v_exp from public.order_expenses where order_id = p_order;
  select coalesce(sum(c.total_cost_cents),0) into v_items_cost from public.order_item_costs c join public.order_items i on i.id = c.item_id
   where i.order_id = p_order and i.status in ('approved','in_progress','done');
  return jsonb_build_object('total_cents', v_total, 'expenses_cents', v_exp, 'stock_cost_cents', v_items_cost,
    'left_cents', v_total - v_exp - v_items_cost,
    'definicao', 'Sobra = valor do serviço − gastos anotados − custo das peças do estoque. Não inclui aluguel, salários e outras despesas fixas.');
end $$;

-- ---------------------------------------------------------------------
-- Portal: Pix para pagar e histórico do carro (só do dono atual)
-- ---------------------------------------------------------------------
create or replace function public.portal_pix(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links; w public.workshops; v_amount bigint;
begin
  l := private.portal_resolve(p_token);
  select * into w from public.workshops where id = l.workshop_id;
  if coalesce(w.pix_key, '') = '' then return null; end if;
  if l.order_id is not null then
    select coalesce(sum(ai.amount_cents - ai.paid_cents), 0) into v_amount
      from public.account_installments ai join public.accounts a on a.id = ai.account_id
     where a.order_id = l.order_id and a.kind = 'receivable' and a.status = 'open';
    if v_amount = 0 then
      select case when o.status in ('ready','delivered') and not exists (select 1 from public.accounts a where a.order_id = o.id and a.kind = 'receivable' and a.status <> 'cancelled')
                  then (select coalesce(sum(total_cents),0) from public.order_items where order_id = o.id and status = 'done') else 0 end
        into v_amount from public.service_orders o where o.id = l.order_id;
    end if;
  else
    select v.total_cents into v_amount from public.quotes q join public.quote_versions v on v.id = q.current_version_id where q.id = l.quote_id;
  end if;
  return jsonb_build_object('key', w.pix_key, 'name', coalesce(nullif(w.pix_name,''), w.name), 'city', coalesce(nullif(w.pix_city,''), w.address->>'city', 'BRASIL'),
                            'amount_cents', v_amount);
end $$;

create or replace function public.portal_history(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.portal_links;
begin
  l := private.portal_resolve(p_token);
  -- somente atendimentos deste cliente neste carro: dono anterior não aparece
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'number', o.number, 'date', coalesce(o.delivered_at, o.entry_at), 'km', o.km_entry, 'status', o.status,
      'items', (select coalesce(jsonb_agg(i.description order by i.sort), '[]'::jsonb) from public.order_items i where i.order_id = o.id and i.status = 'done'))
      order by coalesce(o.delivered_at, o.entry_at) desc), '[]'::jsonb)
    from public.service_orders o
   where o.vehicle_id = l.vehicle_id and o.client_id = l.client_id and o.status = 'delivered');
end $$;

grant execute on function public.portal_pix(text), public.portal_history(text) to anon, authenticated;
grant execute on function public.order_profit(uuid) to authenticated;
revoke execute on function public.order_profit(uuid) from anon, public;
