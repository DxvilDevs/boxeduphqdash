-- Boxed Up HQ / Supabase schema v2
-- Run this entire file in Supabase -> SQL Editor.
-- It is safe to re-run and upgrades the original Boxed Up HQ schema.
--
-- SECURITY MODEL
-- * Browser uses a Supabase publishable/legacy anon key only.
-- * RLS enforces access based on workspace membership and role permissions.
-- * The bootstrap owner is locked to dxvil6354@gmail.com.
-- * Only that protected owner can hold the owner role.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_roles (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role_key text not null,
  name text not null check (char_length(name) between 1 and 50),
  description text,
  color text not null default 'gray',
  permissions jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, role_key),
  constraint workspace_roles_key_format check (role_key ~ '^[a-z][a-z0-9_-]{1,31}$')
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'developer',
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.trackers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  icon text not null default '📋',
  description text,
  kind text not null default 'table' check (kind in ('table','kanban')),
  sort_order integer not null default 0,
  settings jsonb not null default '{}'::jsonb,
  archived boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  status text not null default 'Not started' check (status in ('Not started','In progress','Done')),
  priority text check (priority is null or priority in ('Low','Medium','High','Urgent')),
  item_type text,
  description text,
  effort_level text check (effort_level is null or effort_level in ('Small','Medium','Large')),
  due_date date,
  assignee_id uuid references auth.users(id) on delete set null,
  progress integer not null default 0 check (progress between 0 and 100),
  sort_order integer not null default 0,
  custom_data jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'developer',
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Upgrade the original v1 role enum/check constraints to flexible workspace roles.
alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;

create index if not exists idx_workspace_members_user on public.workspace_members(user_id);
create index if not exists idx_workspace_roles_workspace on public.workspace_roles(workspace_id, sort_order);
create index if not exists idx_trackers_workspace on public.trackers(workspace_id, sort_order);
create index if not exists idx_items_tracker on public.items(tracker_id, status, sort_order);
create index if not exists idx_items_workspace on public.items(workspace_id);
create index if not exists idx_items_assignee_due on public.items(assignee_id, due_date) where status <> 'Done';
create index if not exists idx_invites_workspace on public.workspace_invites(workspace_id, created_at desc);

-- Default roles for existing and future workspaces.
insert into public.workspace_roles (workspace_id, role_key, name, description, color, permissions, is_system, sort_order)
select w.id, r.role_key, r.name, r.description, r.color, r.permissions, true, r.sort_order
from public.workspaces w
cross join (
  values
    ('owner', 'Owner', 'Protected workspace owner. Full access.', 'yellow',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":true,"members.invite":true,"members.manage":true,"workspace.manage":true}'::jsonb, 10),
    ('admin', 'Admin', 'Manages production, trackers and team members.', 'red',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":true,"members.invite":true,"members.manage":true,"workspace.manage":false}'::jsonb, 20),
    ('developer', 'Developer', 'Creates and updates production work.', 'blue',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":false,"members.invite":false,"members.manage":false,"workspace.manage":false}'::jsonb, 30),
    ('viewer', 'Viewer', 'Read-only workspace access.', 'gray',
      '{"items.create":false,"items.edit":false,"items.delete":false,"trackers.create":false,"trackers.edit":false,"trackers.delete":false,"members.invite":false,"members.manage":false,"workspace.manage":false}'::jsonb, 40)
) as r(role_key, name, description, color, permissions, sort_order)
on conflict (workspace_id, role_key) do nothing;

-- Migrate old editor memberships/invites into the Developer role.
update public.workspace_members set role = 'developer' where role = 'editor';
update public.workspace_invites set role = 'developer' where role = 'editor';
-- If the protected owner account already exists while upgrading v1, transfer the
-- first Boxed Up HQ workspace to it before the immutability trigger is installed.
do $$
declare
  v_owner uuid;
  v_workspace uuid;
  v_owner_email text := 'dxvil6354@gmail.com';
begin
  select id into v_owner from auth.users where lower(email) = v_owner_email order by created_at limit 1;
  if v_owner is not null then
    select id into v_workspace
    from public.workspaces
    where lower(name) = 'boxed up hq'
    order by created_at
    limit 1;

    if v_workspace is not null then
      update public.workspaces set created_by = v_owner where id = v_workspace;
      insert into public.profiles (id, email, display_name)
      select id, lower(email), coalesce(raw_user_meta_data->>'display_name', split_part(email, '@', 1))
      from auth.users where id = v_owner
      on conflict (id) do update set email = excluded.email;
      insert into public.workspace_members (workspace_id, user_id, role)
      values (v_workspace, v_owner, 'owner')
      on conflict (workspace_id, user_id) do update set role = 'owner';
    end if;
  end if;
end $$;

-- v1 allowed additional owners. v2 keeps one protected owner: workspaces.created_by.
update public.workspace_members wm
set role = 'admin'
from public.workspaces w
where wm.workspace_id = w.id
  and wm.role = 'owner'
  and wm.user_id <> w.created_by;

-- Add role foreign keys after default roles have been seeded.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_role_fk') then
    alter table public.workspace_members
      add constraint workspace_members_role_fk
      foreign key (workspace_id, role)
      references public.workspace_roles(workspace_id, role_key)
      on update cascade on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspace_invites_role_fk') then
    alter table public.workspace_invites
      add constraint workspace_invites_role_fk
      foreign key (workspace_id, role)
      references public.workspace_roles(workspace_id, role_key)
      on update cascade on delete restrict;
  end if;
end $$;

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function public.set_updated_at();

drop trigger if exists workspace_roles_set_updated_at on public.workspace_roles;
create trigger workspace_roles_set_updated_at before update on public.workspace_roles
for each row execute function public.set_updated_at();

drop trigger if exists trackers_set_updated_at on public.trackers;
create trigger trackers_set_updated_at before update on public.trackers
for each row execute function public.set_updated_at();

drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at before update on public.items
for each row execute function public.set_updated_at();

-- Protect the workspace creator and the owner role at the database layer.
create or replace function public.protect_workspace_creator()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.created_by <> old.created_by then
    raise exception 'Workspace owner cannot be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_protect_creator on public.workspaces;
create trigger workspaces_protect_creator before update on public.workspaces
for each row execute function public.protect_workspace_creator();

create or replace function public.protect_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_creator uuid;
begin
  if tg_op = 'DELETE' then
    v_workspace := old.workspace_id;
  else
    v_workspace := new.workspace_id;
  end if;

  select created_by into v_creator from public.workspaces where id = v_workspace;

  if tg_op = 'DELETE' then
    if old.user_id = v_creator then
      raise exception 'The protected Owner cannot be removed.';
    end if;
    return old;
  end if;

  if new.user_id = v_creator and new.role <> 'owner' then
    raise exception 'The protected Owner must keep the owner role.';
  end if;
  if new.role = 'owner' and new.user_id <> v_creator then
    raise exception 'Owner role is reserved for the protected workspace owner.';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_members_protect_owner on public.workspace_members;
create trigger workspace_members_protect_owner
before insert or update or delete on public.workspace_members
for each row execute function public.protect_owner_membership();

-- Auth profile trigger
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, 'member'), '@', 1))
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- Security helpers. SECURITY DEFINER prevents RLS policy recursion.
create or replace function public.is_workspace_member(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace and wm.user_id = auth.uid()
  );
$$;

create or replace function public.workspace_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace and wm.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.has_workspace_permission(p_workspace uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    case
      when wm.role = 'owner' then true
      else (wr.permissions -> p_permission) = 'true'::jsonb
    end,
    false
  )
  from public.workspace_members wm
  left join public.workspace_roles wr
    on wr.workspace_id = wm.workspace_id and wr.role_key = wm.role
  where wm.workspace_id = p_workspace and wm.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.shares_workspace(p_other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = p_other_user
  );
$$;

create or replace function public.is_protected_owner_member(p_workspace uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = p_workspace and w.created_by = p_user
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
revoke all on function public.workspace_role(uuid) from public;
revoke all on function public.has_workspace_permission(uuid,text) from public;
revoke all on function public.shares_workspace(uuid) from public;
revoke all on function public.is_protected_owner_member(uuid,uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.workspace_role(uuid) to authenticated;
grant execute on function public.has_workspace_permission(uuid,text) to authenticated;
grant execute on function public.shares_workspace(uuid) to authenticated;
grant execute on function public.is_protected_owner_member(uuid,uuid) to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_roles enable row level security;
alter table public.workspace_members enable row level security;
alter table public.trackers enable row level security;
alter table public.items enable row level security;
alter table public.workspace_invites enable row level security;

-- Profiles
DROP POLICY IF EXISTS "profiles_select_shared_workspace" ON public.profiles;
create policy "profiles_select_shared_workspace" on public.profiles
for select to authenticated
using (auth.uid() = id or public.shares_workspace(id));

DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
create policy "profiles_update_self" on public.profiles
for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Workspaces
DROP POLICY IF EXISTS "workspaces_select_member" ON public.workspaces;
create policy "workspaces_select_member" on public.workspaces
for select to authenticated
using (public.is_workspace_member(id));

DROP POLICY IF EXISTS "workspaces_insert_creator" ON public.workspaces;
-- Workspace creation is intentionally done through create_boxed_up_workspace(), not direct browser inserts.

DROP POLICY IF EXISTS "workspaces_update_owner" ON public.workspaces;
DROP POLICY IF EXISTS "workspaces_update_manager" ON public.workspaces;
create policy "workspaces_update_manager" on public.workspaces
for update to authenticated
using (public.has_workspace_permission(id, 'workspace.manage'))
with check (public.has_workspace_permission(id, 'workspace.manage'));

DROP POLICY IF EXISTS "workspaces_delete_owner" ON public.workspaces;
create policy "workspaces_delete_owner" on public.workspaces
for delete to authenticated
using (public.workspace_role(id) = 'owner');

-- Workspace role definitions
DROP POLICY IF EXISTS "workspace_roles_select_member" ON public.workspace_roles;
create policy "workspace_roles_select_member" on public.workspace_roles
for select to authenticated
using (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "workspace_roles_insert_owner" ON public.workspace_roles;
create policy "workspace_roles_insert_owner" on public.workspace_roles
for insert to authenticated
with check (
  public.workspace_role(workspace_id) = 'owner'
  and role_key <> 'owner'
);

DROP POLICY IF EXISTS "workspace_roles_update_owner" ON public.workspace_roles;
create policy "workspace_roles_update_owner" on public.workspace_roles
for update to authenticated
using (public.workspace_role(workspace_id) = 'owner' and role_key <> 'owner')
with check (public.workspace_role(workspace_id) = 'owner' and role_key <> 'owner');

DROP POLICY IF EXISTS "workspace_roles_delete_owner" ON public.workspace_roles;
create policy "workspace_roles_delete_owner" on public.workspace_roles
for delete to authenticated
using (public.workspace_role(workspace_id) = 'owner' and role_key <> 'owner');

-- Workspace members
DROP POLICY IF EXISTS "members_select_workspace" ON public.workspace_members;
create policy "members_select_workspace" on public.workspace_members
for select to authenticated
using (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "members_insert_creator_owner" ON public.workspace_members;
-- Membership is created only by the protected workspace bootstrap or accept_workspace_invite().

DROP POLICY IF EXISTS "members_update_owner" ON public.workspace_members;
DROP POLICY IF EXISTS "members_update_manager" ON public.workspace_members;
create policy "members_update_manager" on public.workspace_members
for update to authenticated
using (
  public.has_workspace_permission(workspace_id, 'members.manage')
  and not public.is_protected_owner_member(workspace_id, user_id)
  and (public.workspace_role(workspace_id) = 'owner' or user_id <> auth.uid())
)
with check (
  public.has_workspace_permission(workspace_id, 'members.manage')
  and role <> 'owner'
  and not public.is_protected_owner_member(workspace_id, user_id)
  and (public.workspace_role(workspace_id) = 'owner' or user_id <> auth.uid())
);

DROP POLICY IF EXISTS "members_delete_owner_or_self" ON public.workspace_members;
DROP POLICY IF EXISTS "members_delete_manager_or_self" ON public.workspace_members;
create policy "members_delete_manager_or_self" on public.workspace_members
for delete to authenticated
using (
  (user_id = auth.uid() and not public.is_protected_owner_member(workspace_id, user_id))
  or (
    public.has_workspace_permission(workspace_id, 'members.manage')
    and not public.is_protected_owner_member(workspace_id, user_id)
  )
);

-- Trackers
DROP POLICY IF EXISTS "trackers_select_member" ON public.trackers;
create policy "trackers_select_member" on public.trackers
for select to authenticated
using (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "trackers_insert_editor" ON public.trackers;
DROP POLICY IF EXISTS "trackers_insert_permission" ON public.trackers;
create policy "trackers_insert_permission" on public.trackers
for insert to authenticated
with check (
  created_by = auth.uid()
  and public.has_workspace_permission(workspace_id, 'trackers.create')
);

DROP POLICY IF EXISTS "trackers_update_editor" ON public.trackers;
DROP POLICY IF EXISTS "trackers_update_permission" ON public.trackers;
create policy "trackers_update_permission" on public.trackers
for update to authenticated
using (public.has_workspace_permission(workspace_id, 'trackers.edit'))
with check (public.has_workspace_permission(workspace_id, 'trackers.edit'));

DROP POLICY IF EXISTS "trackers_delete_owner" ON public.trackers;
DROP POLICY IF EXISTS "trackers_delete_permission" ON public.trackers;
create policy "trackers_delete_permission" on public.trackers
for delete to authenticated
using (public.has_workspace_permission(workspace_id, 'trackers.delete'));

-- Items
DROP POLICY IF EXISTS "items_select_member" ON public.items;
create policy "items_select_member" on public.items
for select to authenticated
using (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "items_insert_editor" ON public.items;
DROP POLICY IF EXISTS "items_insert_permission" ON public.items;
create policy "items_insert_permission" on public.items
for insert to authenticated
with check (
  created_by = auth.uid()
  and public.has_workspace_permission(workspace_id, 'items.create')
  and exists (
    select 1 from public.trackers t
    where t.id = tracker_id and t.workspace_id = workspace_id
  )
  and (
    assignee_id is null or exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_id and wm.user_id = assignee_id
    )
  )
);

DROP POLICY IF EXISTS "items_update_editor" ON public.items;
DROP POLICY IF EXISTS "items_update_permission" ON public.items;
create policy "items_update_permission" on public.items
for update to authenticated
using (public.has_workspace_permission(workspace_id, 'items.edit'))
with check (
  public.has_workspace_permission(workspace_id, 'items.edit')
  and exists (
    select 1 from public.trackers t
    where t.id = tracker_id and t.workspace_id = workspace_id
  )
  and (
    assignee_id is null or exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_id and wm.user_id = assignee_id
    )
  )
);

DROP POLICY IF EXISTS "items_delete_editor" ON public.items;
DROP POLICY IF EXISTS "items_delete_permission" ON public.items;
create policy "items_delete_permission" on public.items
for delete to authenticated
using (public.has_workspace_permission(workspace_id, 'items.delete'));

-- Invites
DROP POLICY IF EXISTS "invites_select_owner" ON public.workspace_invites;
DROP POLICY IF EXISTS "invites_select_manager" ON public.workspace_invites;
create policy "invites_select_manager" on public.workspace_invites
for select to authenticated
using (public.has_workspace_permission(workspace_id, 'members.invite'));

DROP POLICY IF EXISTS "invites_insert_owner" ON public.workspace_invites;
DROP POLICY IF EXISTS "invites_insert_manager" ON public.workspace_invites;
create policy "invites_insert_manager" on public.workspace_invites
for insert to authenticated
with check (
  invited_by = auth.uid()
  and public.has_workspace_permission(workspace_id, 'members.invite')
  and role <> 'owner'
  and exists (
    select 1 from public.workspace_roles wr
    where wr.workspace_id = workspace_id and wr.role_key = role
  )
);

DROP POLICY IF EXISTS "invites_delete_owner" ON public.workspace_invites;
DROP POLICY IF EXISTS "invites_delete_manager" ON public.workspace_invites;
create policy "invites_delete_manager" on public.workspace_invites
for delete to authenticated
using (public.has_workspace_permission(workspace_id, 'members.invite'));

-- Secure invite acceptance.
create or replace function public.accept_workspace_invite(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.workspace_invites%rowtype;
  v_email text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  v_email := lower(coalesce(auth.jwt()->>'email', ''));

  select * into v_invite
  from public.workspace_invites
  where token = p_token
  for update;

  if not found then raise exception 'Invite not found.'; end if;
  if v_invite.expires_at < now() then raise exception 'Invite has expired.'; end if;
  if lower(v_invite.email) <> v_email then raise exception 'This invite was created for a different email address.'; end if;
  if v_invite.role = 'owner' then raise exception 'Owner access cannot be granted by invite.'; end if;
  if not exists (
    select 1 from public.workspace_roles wr
    where wr.workspace_id = v_invite.workspace_id and wr.role_key = v_invite.role
  ) then
    raise exception 'The invited role no longer exists.';
  end if;

  if v_invite.accepted_at is not null then
    if exists (
      select 1 from public.workspace_members
      where workspace_id = v_invite.workspace_id and user_id = auth.uid()
    ) then return v_invite.workspace_id; end if;
    raise exception 'Invite has already been used.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, auth.uid(), v_invite.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  update public.workspace_invites set accepted_at = now() where id = v_invite.id;
  return v_invite.workspace_id;
end;
$$;

revoke all on function public.accept_workspace_invite(uuid) from public;
grant execute on function public.accept_workspace_invite(uuid) to authenticated;

-- Bootstrap the Boxed Up HQ workspace.
-- This owner lock is intentional: other users must join via an invite.
create or replace function public.create_boxed_up_workspace(p_name text default 'Boxed Up HQ')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_issue uuid;
  v_todo uuid;
  v_weekly uuid;
  v_models uuid;
  v_scripts uuid;
  v_email text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  v_email := lower(coalesce(auth.jwt()->>'email', ''));
  if v_email <> 'dxvil6354@gmail.com' then
    raise exception 'Only dxvil6354@gmail.com can create the Boxed Up HQ workspace. Ask the owner for an invite.';
  end if;

  insert into public.workspaces (name, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Boxed Up HQ'), auth.uid())
  returning id into v_workspace;

  insert into public.workspace_roles (workspace_id, role_key, name, description, color, permissions, is_system, sort_order)
  values
    (v_workspace, 'owner', 'Owner', 'Protected workspace owner. Full access.', 'yellow',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":true,"members.invite":true,"members.manage":true,"workspace.manage":true}', true, 10),
    (v_workspace, 'admin', 'Admin', 'Manages production, trackers and team members.', 'red',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":true,"members.invite":true,"members.manage":true,"workspace.manage":false}', true, 20),
    (v_workspace, 'developer', 'Developer', 'Creates and updates production work.', 'blue',
      '{"items.create":true,"items.edit":true,"items.delete":true,"trackers.create":true,"trackers.edit":true,"trackers.delete":false,"members.invite":false,"members.manage":false,"workspace.manage":false}', true, 30),
    (v_workspace, 'viewer', 'Viewer', 'Read-only workspace access.', 'gray',
      '{"items.create":false,"items.edit":false,"items.delete":false,"trackers.create":false,"trackers.edit":false,"trackers.delete":false,"members.invite":false,"members.manage":false,"workspace.manage":false}', true, 40);

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace, auth.uid(), 'owner');

  insert into public.trackers (workspace_id, name, icon, description, kind, sort_order, settings, created_by)
  values (v_workspace, 'Issue Tracking', '👾', 'Track bugs, blockers and production issues.', 'table', 10, '{"tablePreset":"issues"}', auth.uid())
  returning id into v_issue;

  insert into public.trackers (workspace_id, name, icon, description, kind, sort_order, settings, created_by)
  values (v_workspace, 'Overarching To-Do Tracker', '✅', 'Stay organized with tasks, your way.', 'table', 20, '{"tablePreset":"tasks"}', auth.uid())
  returning id into v_todo;

  insert into public.trackers (workspace_id, name, icon, description, kind, sort_order, settings, created_by)
  values (v_workspace, 'Weekly Update Checklist', '🛠️', 'Next Update: 11th September 2026', 'table', 30, '{"tablePreset":"tasks"}', auth.uid())
  returning id into v_weekly;

  insert into public.trackers (workspace_id, name, icon, description, kind, sort_order, settings, created_by)
  values (v_workspace, 'Models Needed', '🔍', 'Manage and execute modelling work from start to finish.', 'kanban', 40, '{}', auth.uid())
  returning id into v_models;

  insert into public.trackers (workspace_id, name, icon, description, kind, sort_order, settings, created_by)
  values (v_workspace, 'Scripting Needed', '🔍', 'Manage and execute scripting work from start to finish.', 'kanban', 50, '{}', auth.uid())
  returning id into v_scripts;

  insert into public.items (
    workspace_id, tracker_id, title, status, priority, item_type, description,
    effort_level, due_date, progress, sort_order, created_by
  ) values
    (v_workspace, v_weekly, 'F1 Vehicles', 'Not started', 'Medium', '🚗 Vehicle', 'Add the F1 vehicles, fix timers', 'Medium', '2026-09-10', 0, 10, auth.uid()),
    (v_workspace, v_weekly, 'F1 Zone', 'Not started', 'High', '🔧 Map', 'Add F1 to the weekly zone', 'Large', '2026-09-10', 0, 20, auth.uid()),
    (v_workspace, v_weekly, 'Event Board + Event Creation', 'Not started', 'Medium', '🎉 Event', 'Update timer, change event ID', 'Small', '2026-09-10', 0, 30, auth.uid()),
    (v_workspace, v_weekly, 'Dev Product Images', 'Not started', 'Low', '🦩 Polish', 'Do the dev product images', 'Small', '2026-09-10', 0, 40, auth.uid()),
    (v_workspace, v_scripts, 'Admin panel', 'In progress', 'Medium', '💻 Script', 'Build and wire the admin panel.', 'Medium', null, 0, 10, auth.uid());

  return v_workspace;
end;
$$;

revoke all on function public.create_boxed_up_workspace(text) from public;
grant execute on function public.create_boxed_up_workspace(text) to authenticated;

-- Browser grants; RLS still controls every row.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_roles to authenticated;
grant select, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.trackers to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, insert, delete on public.workspace_invites to authenticated;

-- Realtime collaborative edits.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='items') then
    alter publication supabase_realtime add table public.items;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='trackers') then
    alter publication supabase_realtime add table public.trackers;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='workspace_members') then
    alter publication supabase_realtime add table public.workspace_members;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='workspace_roles') then
    alter publication supabase_realtime add table public.workspace_roles;
  end if;
end $$;


-- ============================================================================
-- Lightweight collaboration additions: Studio Feed only.
-- Keeps the original task statuses: Not started / In progress / Done.
-- Online status uses Supabase Realtime Presence and does not require a table.
-- My Work is a filtered view of existing items and does not require a table.
-- ============================================================================

-- Hard-restore the simple original workflow in case the earlier experimental
-- workflow migration was ever applied. This preserves every task and only maps
-- the experimental labels back to the original three Notion-style statuses.
drop trigger if exists items_enforce_workflow on public.items;
drop function if exists public.enforce_item_workflow();

alter table public.items drop constraint if exists items_status_check;
update public.items
set status = case
  when status in ('Backlog','Ready') then 'Not started'
  when status in ('Review','Testing','Approved') then 'In progress'
  when status = 'Shipped' then 'Done'
  else status
end
where status in ('Backlog','Ready','Review','Testing','Approved','Shipped');
alter table public.items alter column status set default 'Not started';
alter table public.items
  add constraint items_status_check
  check (status in ('Not started','In progress','Done'));

drop index if exists public.idx_items_assignee_due;
create index idx_items_assignee_due
  on public.items(assignee_id, due_date)
  where status <> 'Done';

-- Remove permission flags that belonged only to the discarded workflow.
update public.workspace_roles
set permissions = permissions - 'items.approve' - 'updates.ship'
where permissions ? 'items.approve' or permissions ? 'updates.ship';

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  entity_title text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_workspace_created on public.activity_log(workspace_id, created_at desc);
create index if not exists idx_activity_entity on public.activity_log(entity_id, created_at desc);

-- If the abandoned workflow ever wrote feed entries, normalise those labels too.
update public.activity_log
set metadata = jsonb_strip_nulls(
  metadata
  || case when metadata ? 'status' then jsonb_build_object('status', case metadata->>'status'
       when 'Backlog' then 'Not started' when 'Ready' then 'Not started'
       when 'Review' then 'In progress' when 'Testing' then 'In progress' when 'Approved' then 'In progress'
       when 'Shipped' then 'Done' else metadata->>'status' end) else '{}'::jsonb end
  || case when metadata ? 'from_status' then jsonb_build_object('from_status', case metadata->>'from_status'
       when 'Backlog' then 'Not started' when 'Ready' then 'Not started'
       when 'Review' then 'In progress' when 'Testing' then 'In progress' when 'Approved' then 'In progress'
       when 'Shipped' then 'Done' else metadata->>'from_status' end) else '{}'::jsonb end
  || case when metadata ? 'to_status' then jsonb_build_object('to_status', case metadata->>'to_status'
       when 'Backlog' then 'Not started' when 'Ready' then 'Not started'
       when 'Review' then 'In progress' when 'Testing' then 'In progress' when 'Approved' then 'In progress'
       when 'Shipped' then 'Done' else metadata->>'to_status' end) else '{}'::jsonb end
);

-- Record meaningful task changes without adding any new workflow stages.
create or replace function public.log_item_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_workspace uuid;
  v_entity uuid;
  v_title text;
  v_metadata jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'created';
    v_workspace := new.workspace_id;
    v_entity := new.id;
    v_title := new.title;
    v_metadata := jsonb_build_object('status', new.status, 'assignee_id', new.assignee_id, 'tracker_id', new.tracker_id);
  elsif tg_op = 'DELETE' then
    v_action := 'deleted';
    v_workspace := old.workspace_id;
    v_entity := old.id;
    v_title := old.title;
    v_metadata := jsonb_build_object('status', old.status, 'assignee_id', old.assignee_id, 'tracker_id', old.tracker_id);
  else
    v_workspace := new.workspace_id;
    v_entity := new.id;
    v_title := new.title;

    if new.status is distinct from old.status then
      v_action := 'status_changed';
      v_metadata := jsonb_build_object(
        'from_status', old.status,
        'to_status', new.status,
        'assignee_id', new.assignee_id,
        'tracker_id', new.tracker_id
      );
    elsif new.assignee_id is distinct from old.assignee_id then
      v_action := 'assigned';
      v_metadata := jsonb_build_object(
        'from_assignee_id', old.assignee_id,
        'assignee_id', new.assignee_id,
        'tracker_id', new.tracker_id
      );
    elsif new.due_date is distinct from old.due_date then
      v_action := 'due_date_changed';
      v_metadata := jsonb_build_object(
        'from_due_date', old.due_date,
        'to_due_date', new.due_date,
        'assignee_id', new.assignee_id,
        'tracker_id', new.tracker_id
      );
    elsif new.title is distinct from old.title
       or new.description is distinct from old.description
       or new.priority is distinct from old.priority
       or new.effort_level is distinct from old.effort_level
       or new.item_type is distinct from old.item_type
       or new.tracker_id is distinct from old.tracker_id
       or new.progress is distinct from old.progress then
      v_action := 'updated';
      v_metadata := jsonb_build_object('assignee_id', new.assignee_id, 'tracker_id', new.tracker_id);
    else
      return new;
    end if;
  end if;

  insert into public.activity_log (
    workspace_id, actor_id, action, entity_type, entity_id, entity_title, metadata
  ) values (
    v_workspace, auth.uid(), v_action, 'item', v_entity, v_title, v_metadata
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists items_activity_log on public.items;
create trigger items_activity_log
after insert or update or delete on public.items
for each row execute function public.log_item_activity();

create or replace function public.log_tracker_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_workspace uuid;
  v_entity uuid;
  v_title text;
begin
  if tg_op = 'INSERT' then
    v_action := 'created';
    v_workspace := new.workspace_id;
    v_entity := new.id;
    v_title := new.name;
  elsif tg_op = 'DELETE' then
    v_action := 'deleted';
    v_workspace := old.workspace_id;
    v_entity := old.id;
    v_title := old.name;
  else
    if new.name is not distinct from old.name
      and new.description is not distinct from old.description
      and new.kind is not distinct from old.kind
      and new.archived is not distinct from old.archived then
      return new;
    end if;
    v_action := 'updated';
    v_workspace := new.workspace_id;
    v_entity := new.id;
    v_title := new.name;
  end if;

  insert into public.activity_log (
    workspace_id, actor_id, action, entity_type, entity_id, entity_title
  ) values (
    v_workspace, auth.uid(), v_action, 'tracker', v_entity, v_title
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trackers_activity_log on public.trackers;
create trigger trackers_activity_log
after insert or update or delete on public.trackers
for each row execute function public.log_tracker_activity();

create or replace function public.log_member_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_workspace uuid;
  v_user uuid;
  v_metadata jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'member_joined';
    v_workspace := new.workspace_id;
    v_user := new.user_id;
    v_metadata := jsonb_build_object('to_role', new.role, 'user_id', new.user_id);
  elsif tg_op = 'DELETE' then
    v_action := 'member_removed';
    v_workspace := old.workspace_id;
    v_user := old.user_id;
    v_metadata := jsonb_build_object('from_role', old.role, 'user_id', old.user_id);
  else
    if new.role is not distinct from old.role then return new; end if;
    v_action := 'role_changed';
    v_workspace := new.workspace_id;
    v_user := new.user_id;
    v_metadata := jsonb_build_object('from_role', old.role, 'to_role', new.role, 'user_id', new.user_id);
  end if;

  insert into public.activity_log (
    workspace_id, actor_id, action, entity_type, entity_id, entity_title, metadata
  ) values (
    v_workspace, auth.uid(), v_action, 'member', v_user, 'team member', v_metadata
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists workspace_members_activity_log on public.workspace_members;
create trigger workspace_members_activity_log
after insert or update or delete on public.workspace_members
for each row execute function public.log_member_activity();

revoke all on function public.log_item_activity() from public;
revoke all on function public.log_tracker_activity() from public;
revoke all on function public.log_member_activity() from public;

alter table public.activity_log enable row level security;
DROP POLICY IF EXISTS "activity_select_member" ON public.activity_log;
create policy "activity_select_member" on public.activity_log
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.activity_log to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='activity_log'
  ) then
    alter publication supabase_realtime add table public.activity_log;
  end if;
end $$;
