-- Sauna Conductor: cloud sync schema for Supabase.
-- Run this once in the Supabase dashboard → SQL Editor. Running it again is safe.
--
-- Model: everyone belongs to one or more workspaces (e.g. "Sauna" for Olafur and Thora).
-- Sessions, recorded narration, run history and the shared ElevenLabs key belong to a workspace.
-- Each person's own Spotify login lives in user_settings, readable only by that person.

-- ------------------------------------------------------------------ tables
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Sauna',
  settings    jsonb not null default '{}'::jsonb,      -- shared settings, e.g. { "elKey": "...", "elKeyAt": 0 }
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  email        text,
  name         text,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.invites (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null check (email = lower(email)),
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index if not exists invites_email_idx on public.invites(email);

create table if not exists public.sessions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id           text not null,
  data         jsonb not null,
  updated_at   bigint not null,                        -- the app's session.updatedAt (ms)
  deleted      boolean not null default false,
  updated_by   uuid default auth.uid(),
  server_at    timestamptz not null default now(),
  primary key (workspace_id, id)
);

create table if not exists public.clips (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id   text not null,
  cue          text not null,
  key          text,                                   -- hash of text + voice, to spot outdated clips
  source       text,                                   -- 'generated' | 'uploaded'
  chars        integer not null default 0,
  at           bigint not null,                        -- when it was recorded (ms)
  path         text not null,                          -- object path in the "clips" storage bucket
  size         integer,
  type         text,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, session_id, cue)
);

create table if not exists public.runs (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id       text not null,
  session_id   text,
  active       boolean not null default false,          -- true while a session is running (for resume)
  data         jsonb not null,
  updated_at   bigint not null,
  updated_by   uuid default auth.uid(),
  primary key (workspace_id, run_id)
);

create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,       -- e.g. { "spotify": { "r": refresh token, "s": scope, "at": ms } }
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------ helpers
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

-- For storage paths like "<workspace id>/<session id>/<file>.mp3".
create or replace function public.is_member_path(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_member(split_part(object_name, '/', 1)::uuid)
    else false
  end;
$$;

-- Called by the app after every sign-in: joins workspaces you were invited to,
-- creates your own workspace if you have none, and returns your workspaces.
create or replace function public.bootstrap()
returns setof public.workspaces language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  em   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  nm   text := coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', split_part(em, '@', 1));
  ws   uuid;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if em <> '' then
    insert into public.members (workspace_id, user_id, email, name, role)
      select i.workspace_id, uid, em, nm, 'member' from public.invites i where i.email = em
      on conflict (workspace_id, user_id) do nothing;
    delete from public.invites where email = em;
  end if;
  update public.members set email = em, name = nm where user_id = uid and (email is distinct from em or name is distinct from nm);
  if not exists (select 1 from public.members where user_id = uid) then
    insert into public.workspaces (name, created_by) values ('Sauna', uid) returning id into ws;
    insert into public.members (workspace_id, user_id, email, name, role) values (ws, uid, em, nm, 'owner');
  end if;
  return query
    select w.* from public.workspaces w join public.members m on m.workspace_id = w.id
    where m.user_id = uid order by m.joined_at, w.created_at;
end;
$$;

-- Saves a session only if it is newer than the copy in the cloud. Returns the stored updated_at,
-- or null when the cloud already had a newer version (the app then downloads that one).
create or replace function public.put_session(ws uuid, sid text, body jsonb, ts bigint, del boolean default false)
returns bigint language sql security invoker set search_path = public as $$
  insert into public.sessions as s (workspace_id, id, data, updated_at, deleted, updated_by, server_at)
  values (ws, sid, body, ts, del, auth.uid(), now())
  on conflict (workspace_id, id) do update
    set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
        updated_by = excluded.updated_by, server_at = now()
    where s.updated_at < excluded.updated_at
  returning updated_at;
$$;

-- Owners can remove someone from the workspace; anyone can remove themselves.
create or replace function public.remove_member(ws uuid, member uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if member <> auth.uid() and not exists (
    select 1 from public.members where workspace_id = ws and user_id = auth.uid() and role = 'owner'
  ) then raise exception 'Only the owner can remove other people'; end if;
  delete from public.members where workspace_id = ws and user_id = member;
end;
$$;

-- ------------------------------------------------------------------ row level security
alter table public.workspaces    enable row level security;
alter table public.members       enable row level security;
alter table public.invites       enable row level security;
alter table public.sessions      enable row level security;
alter table public.clips         enable row level security;
alter table public.runs          enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists ws_select on public.workspaces;
drop policy if exists ws_update on public.workspaces;
create policy ws_select on public.workspaces for select to authenticated using (public.is_member(id));
create policy ws_update on public.workspaces for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists mem_select on public.members;
create policy mem_select on public.members for select to authenticated using (public.is_member(workspace_id));

drop policy if exists inv_all on public.invites;
create policy inv_all on public.invites for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

drop policy if exists ses_all on public.sessions;
create policy ses_all on public.sessions for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

drop policy if exists clip_all on public.clips;
create policy clip_all on public.clips for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

drop policy if exists run_all on public.runs;
create policy run_all on public.runs for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

drop policy if exists us_own on public.user_settings;
create policy us_own on public.user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------ privileges
revoke all on public.workspaces, public.members, public.invites, public.sessions, public.clips, public.runs, public.user_settings from anon;
grant select, update on public.workspaces to authenticated;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.invites, public.sessions, public.clips, public.runs, public.user_settings to authenticated;
revoke all on function public.bootstrap(), public.put_session(uuid, text, jsonb, bigint, boolean), public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.bootstrap(), public.put_session(uuid, text, jsonb, bigint, boolean), public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.is_member(uuid), public.is_member_path(text) to authenticated;

-- ------------------------------------------------------------------ storage for the recorded narration
insert into storage.buckets (id, name, public, file_size_limit)
values ('clips', 'clips', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "clips read" on storage.objects;
drop policy if exists "clips add" on storage.objects;
drop policy if exists "clips change" on storage.objects;
drop policy if exists "clips remove" on storage.objects;
create policy "clips read"   on storage.objects for select to authenticated using (bucket_id = 'clips' and public.is_member_path(name));
create policy "clips add"    on storage.objects for insert to authenticated with check (bucket_id = 'clips' and public.is_member_path(name));
create policy "clips change" on storage.objects for update to authenticated using (bucket_id = 'clips' and public.is_member_path(name));
create policy "clips remove" on storage.objects for delete to authenticated using (bucket_id = 'clips' and public.is_member_path(name));
