-- Ligações que as telas usam nas consultas (PostgREST só embute tabelas
-- relacionadas por chave estrangeira).

-- equipe: memberships → profiles (nome e e-mail do funcionário)
insert into public.profiles(user_id, email)
select u.id, lower(u.email) from auth.users u
 where not exists (select 1 from public.profiles p where p.user_id = u.id);
alter table public.memberships
  add constraint memberships_profile_fk foreign key (user_id) references public.profiles(user_id);

-- tarefas de contato → veículo
update public.contact_tasks t set vehicle_id = null
 where vehicle_id is not null and not exists (select 1 from public.vehicles v where v.id = t.vehicle_id and v.workshop_id = t.workshop_id);
alter table public.contact_tasks
  add constraint contact_tasks_vehicle_fk foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id);
