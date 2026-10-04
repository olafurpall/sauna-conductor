-- Sauna Conductor: database schema for Supabase (version 3.1).
-- Run it in the Supabase dashboard → SQL Editor. Running it again is safe.
--
-- Model: every person has their own private space (a "workspace" with one owner).
-- Sessions, recorded narration, run history and plays belong to the owner's space.
-- A single session can be shared:
--   * by invite (email), as a collaborator (can edit) or a viewer (can only run it);
--   * by a link anyone can open after signing in (they become viewers).
-- Each person's own Spotify login lives in user_settings, readable only by that person.
-- The ElevenLabs and Anthropic keys never reach a browser: they live in app_secrets (or in the
-- Edge Function secrets) and are used only by the server functions "eleven" and "write".
-- Callout profiles (3.1): short clips a person recorded, set up by the admin, usable by everyone once published.

-- ------------------------------------------------------------------ tables
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Sauna',
  settings    jsonb not null default '{}'::jsonb,
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

-- Kept for older versions of the app; version 3 no longer invites people into a workspace.
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

-- One session shared with one person, by email. role: 'editor' (collaborator) or 'viewer'.
create table if not exists public.session_shares (
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  session_id      text not null,
  email           text not null check (email = lower(email)),
  invited_by      uuid references auth.users(id) on delete set null,
  invited_by_name text,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, session_id, email)
);
alter table public.session_shares add column if not exists role text not null default 'editor';
alter table public.session_shares add column if not exists owner_name text;
alter table public.session_shares add column if not exists via_link boolean not null default false;
do $$ begin
  alter table public.session_shares add constraint session_shares_role_check check (role in ('editor', 'viewer'));
exception when duplicate_object then null; end $$;
create index if not exists session_shares_email_idx on public.session_shares(email);

-- A link to one session that anyone can open after signing in (they become viewers).
create table if not exists public.session_links (
  token           text primary key check (length(token) >= 16),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  session_id      text not null,
  created_by      uuid default auth.uid() references auth.users(id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  revoked         boolean not null default false
);
create index if not exists session_links_session_idx on public.session_links(workspace_id, session_id);

-- One row per play of a session (a run that finished or lasted 10 minutes), from anyone.
create table if not exists public.session_plays (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id   text not null,
  run_id       text not null,
  user_id      uuid default auth.uid(),
  played_at    timestamptz not null default now(),
  elapsed_ms   bigint,
  status       text,
  primary key (workspace_id, session_id, run_id)
);

create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,       -- e.g. { "spotify": { "r": refresh token, "s": scope, "at": ms } }
  updated_at  timestamptz not null default now()
);

-- People who run the app (see access requests, unlimited narration).
create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Spotify only lets people on the app's user list in (5 at most). Those turned away ask here.
create table if not exists public.access_requests (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  email         text,
  name          text,
  spotify_email text not null,
  note          text,
  status        text not null default 'pending' check (status in ('pending', 'added', 'declined')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Server-only secrets (no browser can read them). Used by the Edge Functions.
create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- How much each person used today (narration characters, AI writing), for the daily limits.
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  kind    text not null,
  amount  bigint not null default 0,
  primary key (user_id, day, kind)
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

create or replace function public.auth_email()
returns text language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid());
$$;

-- Can see and run the session: its owner, and anyone it is shared with.
create or replace function public.can_access_session(ws uuid, sid text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_member(ws) or exists (
    select 1 from public.session_shares sh
    where sh.workspace_id = ws and sh.session_id = sid and sh.email = public.auth_email() and public.auth_email() <> ''
  );
$$;

-- Can change the session: its owner, and collaborators.
create or replace function public.can_edit_session(ws uuid, sid text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_member(ws) or exists (
    select 1 from public.session_shares sh
    where sh.workspace_id = ws and sh.session_id = sid and sh.email = public.auth_email() and public.auth_email() <> ''
      and sh.role = 'editor'
  );
$$;

-- Storage paths are "<workspace id>/<session id>/<file>".
create or replace function public.can_access_path(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.can_access_session(split_part(object_name, '/', 1)::uuid, split_part(object_name, '/', 2))
    else false
  end;
$$;
create or replace function public.can_edit_path(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.can_edit_session(split_part(object_name, '/', 1)::uuid, split_part(object_name, '/', 2))
    else false
  end;
$$;

-- The name of a space's owner (shown as "Shared by …").
create or replace function public.owner_name(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(m.name, ''), m.email) from public.members m where m.workspace_id = ws and m.role = 'owner' limit 1;
$$;

create or replace function public.shares_set_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_name := coalesce(public.owner_name(new.workspace_id), new.owner_name);
  return new;
end;
$$;
drop trigger if exists shares_owner on public.session_shares;
create trigger shares_owner before insert or update on public.session_shares
  for each row execute function public.shares_set_owner();

-- Plays per session, for every session you can see.
create or replace function public.play_counts()
returns table (workspace_id uuid, session_id text, plays bigint, last_played timestamptz)
language sql stable security invoker set search_path = public as $$
  select p.workspace_id, p.session_id, count(*)::bigint, max(p.played_at)
  from public.session_plays p group by p.workspace_id, p.session_id;
$$;

-- Called by the app after every sign-in: creates your own space if you have none and returns it.
create or replace function public.bootstrap()
returns setof public.workspaces language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  em   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  nm   text := coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', split_part(em, '@', 1));
  ws   uuid;
begin
  if uid is null then raise exception 'Not signed in'; end if;
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
-- Collaborators can save changes but not delete; only the owner deletes. Viewers can't save.
create or replace function public.put_session(ws uuid, sid text, body jsonb, ts bigint, del boolean default false)
returns bigint language plpgsql security invoker set search_path = public as $$
declare res bigint;
begin
  if del and not public.is_member(ws) then raise exception 'Only the owner can delete this session'; end if;
  insert into public.sessions as s (workspace_id, id, data, updated_at, deleted, updated_by, server_at)
  values (ws, sid, body, ts, del, auth.uid(), now())
  on conflict (workspace_id, id) do update
    set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
        updated_by = excluded.updated_by, server_at = now()
    where s.updated_at < excluded.updated_at
  returning updated_at into res;
  return res;
end;
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

-- What a shared link points to, for the front page before signing in.
create or replace function public.link_info(tok text)
returns table (session_name text, owner text, notes text, rounds int, minutes int)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(s.data ->> 'name', ''), 'A sauna session'),
         coalesce(l.created_by_name, public.owner_name(l.workspace_id)),
         left(coalesce(s.data ->> 'notes', ''), 200),
         coalesce((s.data -> 'timing' ->> 'rounds')::int, 0),
         coalesce((s.data ->> 'totalMin')::int, 0)
  from public.session_links l
  join public.sessions s on s.workspace_id = l.workspace_id and s.id = l.session_id and not s.deleted
  where l.token = tok and not l.revoked;
$$;

-- Opening a shared link after signing in: you become a viewer of that session (unless you
-- already have it). Returns where the session lives.
create or replace function public.claim_link(tok text)
returns table (workspace_id uuid, session_id text) language plpgsql security definer set search_path = public as $$
declare
  l public.session_links;
  em text := public.auth_email();
begin
  if auth.uid() is null or em = '' then raise exception 'Not signed in'; end if;
  select * into l from public.session_links where token = tok and not revoked;
  if not found or not exists (select 1 from public.sessions s where s.workspace_id = l.workspace_id and s.id = l.session_id and not s.deleted)
    then raise exception 'This link no longer works. Ask for a new one.'; end if;
  if not public.is_member(l.workspace_id) then
    insert into public.session_shares (workspace_id, session_id, email, role, invited_by, invited_by_name, via_link)
    values (l.workspace_id, l.session_id, em, 'viewer', l.created_by, l.created_by_name, true)
    on conflict on constraint session_shares_pkey do nothing;
  end if;
  return query select l.workspace_id, l.session_id;
end;
$$;

-- Asking for Spotify access (or asking again).
create or replace function public.request_access(spotify_email text, note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(spotify_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That does not look like an email address.'; end if;
  insert into public.access_requests (user_id, email, name, spotify_email, note, status, created_at, updated_at)
  values (auth.uid(), public.auth_email(),
          coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', ''),
          lower(trim(spotify_email)), left(coalesce(note, ''), 500), 'pending', now(), now())
  on conflict (user_id) do update
    set spotify_email = excluded.spotify_email, note = excluded.note, status = 'pending',
        email = excluded.email, name = excluded.name, updated_at = now();
end;
$$;

-- Admins mark a request as handled.
create or replace function public.set_request_status(uid uuid, new_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can do that'; end if;
  update public.access_requests set status = new_status, updated_at = now() where user_id = uid;
end;
$$;

-- Used only by the server functions (service role): count usage and check the daily limit.
create or replace function public.bump_usage(uid uuid, what text, n bigint, cap bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare used bigint;
begin
  insert into public.usage_daily (user_id, day, kind, amount) values (uid, current_date, what, 0)
  on conflict do nothing;
  select amount into used from public.usage_daily where user_id = uid and day = current_date and kind = what for update;
  if cap > 0 and used + n > cap then return false; end if;
  update public.usage_daily set amount = amount + n where user_id = uid and day = current_date and kind = what;
  return true;
end;
$$;

-- ------------------------------------------------------------------ row level security
alter table public.workspaces      enable row level security;
alter table public.members         enable row level security;
alter table public.invites         enable row level security;
alter table public.sessions        enable row level security;
alter table public.clips           enable row level security;
alter table public.runs            enable row level security;
alter table public.user_settings   enable row level security;
alter table public.session_shares  enable row level security;
alter table public.session_plays   enable row level security;
alter table public.session_links   enable row level security;
alter table public.app_admins      enable row level security;
alter table public.access_requests enable row level security;
alter table public.app_secrets     enable row level security;   -- no policies: no browser can read it
alter table public.usage_daily     enable row level security;

drop policy if exists ws_select on public.workspaces;
drop policy if exists ws_update on public.workspaces;
create policy ws_select on public.workspaces for select to authenticated using (public.is_member(id));
create policy ws_update on public.workspaces for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists mem_select on public.members;
create policy mem_select on public.members for select to authenticated using (public.is_member(workspace_id));

drop policy if exists inv_all on public.invites;
create policy inv_all on public.invites for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

-- Sessions and their recordings: the owner and collaborators change them, viewers only read them,
-- only the owner deletes.
drop policy if exists ses_all on public.sessions;
drop policy if exists ses_read on public.sessions;
drop policy if exists ses_add on public.sessions;
drop policy if exists ses_change on public.sessions;
drop policy if exists ses_remove on public.sessions;
create policy ses_read   on public.sessions for select to authenticated using (public.can_access_session(workspace_id, id));
create policy ses_add    on public.sessions for insert to authenticated with check (public.can_edit_session(workspace_id, id));
create policy ses_change on public.sessions for update to authenticated using (public.can_edit_session(workspace_id, id)) with check (public.can_edit_session(workspace_id, id));
create policy ses_remove on public.sessions for delete to authenticated using (public.is_member(workspace_id));

drop policy if exists clip_all on public.clips;
drop policy if exists clip_read on public.clips;
drop policy if exists clip_add on public.clips;
drop policy if exists clip_change on public.clips;
drop policy if exists clip_remove on public.clips;
create policy clip_read   on public.clips for select to authenticated using (public.can_access_session(workspace_id, session_id));
create policy clip_add    on public.clips for insert to authenticated with check (public.can_edit_session(workspace_id, session_id));
create policy clip_change on public.clips for update to authenticated using (public.can_edit_session(workspace_id, session_id)) with check (public.can_edit_session(workspace_id, session_id));
create policy clip_remove on public.clips for delete to authenticated using (public.is_member(workspace_id));

-- Who a session is shared with: visible to its owner, its collaborators and the person themselves.
-- The owner and collaborators invite and change roles; the owner removes anyone; you can remove yourself.
drop policy if exists share_read on public.session_shares;
drop policy if exists share_add on public.session_shares;
drop policy if exists share_change on public.session_shares;
drop policy if exists share_remove on public.session_shares;
create policy share_read   on public.session_shares for select to authenticated
  using (public.can_edit_session(workspace_id, session_id) or email = public.auth_email());
create policy share_add    on public.session_shares for insert to authenticated with check (public.can_edit_session(workspace_id, session_id));
create policy share_change on public.session_shares for update to authenticated
  using (public.can_edit_session(workspace_id, session_id)) with check (public.can_edit_session(workspace_id, session_id));
create policy share_remove on public.session_shares for delete to authenticated
  using (public.can_edit_session(workspace_id, session_id) or email = public.auth_email());

drop policy if exists link_read on public.session_links;
drop policy if exists link_add on public.session_links;
drop policy if exists link_change on public.session_links;
create policy link_read   on public.session_links for select to authenticated using (public.can_edit_session(workspace_id, session_id));
create policy link_add    on public.session_links for insert to authenticated with check (public.can_edit_session(workspace_id, session_id));
create policy link_change on public.session_links for update to authenticated
  using (public.can_edit_session(workspace_id, session_id)) with check (public.can_edit_session(workspace_id, session_id));

drop policy if exists play_read on public.session_plays;
drop policy if exists play_add on public.session_plays;
drop policy if exists play_change on public.session_plays;
create policy play_read   on public.session_plays for select to authenticated using (public.can_access_session(workspace_id, session_id));
create policy play_add    on public.session_plays for insert to authenticated with check (public.can_access_session(workspace_id, session_id));
create policy play_change on public.session_plays for update to authenticated using (public.can_access_session(workspace_id, session_id)) with check (public.can_access_session(workspace_id, session_id));

drop policy if exists run_all on public.runs;
create policy run_all on public.runs for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

drop policy if exists us_own on public.user_settings;
create policy us_own on public.user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists admin_self on public.app_admins;
create policy admin_self on public.app_admins for select to authenticated using (user_id = auth.uid());

drop policy if exists req_read on public.access_requests;
create policy req_read on public.access_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists usage_own on public.usage_daily;
create policy usage_own on public.usage_daily for select to authenticated using (user_id = auth.uid());

-- ------------------------------------------------------------------ privileges
revoke all on public.workspaces, public.members, public.invites, public.sessions, public.clips, public.runs, public.user_settings,
  public.session_shares, public.session_plays, public.session_links, public.app_admins, public.access_requests,
  public.app_secrets, public.usage_daily from anon;
revoke all on public.app_secrets from authenticated;
revoke insert, update, delete on public.access_requests, public.app_admins, public.usage_daily from authenticated;
grant select, update on public.workspaces to authenticated;
grant select on public.members, public.app_admins, public.access_requests, public.usage_daily to authenticated;
grant select, insert, update, delete on public.invites, public.sessions, public.clips, public.runs, public.user_settings, public.session_shares to authenticated;
grant select, insert, update on public.session_plays, public.session_links to authenticated;
grant all on public.app_secrets, public.usage_daily, public.access_requests, public.app_admins to service_role;

revoke all on function public.bootstrap(), public.put_session(uuid, text, jsonb, bigint, boolean), public.remove_member(uuid, uuid),
  public.claim_link(text), public.request_access(text, text), public.set_request_status(uuid, text), public.play_counts() from public, anon;
grant execute on function public.bootstrap(), public.put_session(uuid, text, jsonb, bigint, boolean), public.remove_member(uuid, uuid),
  public.claim_link(text), public.request_access(text, text), public.set_request_status(uuid, text), public.play_counts() to authenticated;
grant execute on function public.is_member(uuid), public.is_member_path(text), public.auth_email(), public.is_admin(),
  public.can_access_session(uuid, text), public.can_edit_session(uuid, text), public.can_access_path(text), public.can_edit_path(text),
  public.owner_name(uuid) to authenticated;
-- The front page can describe a shared link before anyone signs in.
grant execute on function public.link_info(text) to anon, authenticated;
revoke all on function public.bump_usage(uuid, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, text, bigint, bigint) to service_role;

-- ------------------------------------------------------------------ storage for the recorded narration
insert into storage.buckets (id, name, public, file_size_limit)
values ('clips', 'clips', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "clips read" on storage.objects;
drop policy if exists "clips add" on storage.objects;
drop policy if exists "clips change" on storage.objects;
drop policy if exists "clips remove" on storage.objects;
create policy "clips read"   on storage.objects for select to authenticated using (bucket_id = 'clips' and public.can_access_path(name));
create policy "clips add"    on storage.objects for insert to authenticated with check (bucket_id = 'clips' and public.can_edit_path(name));
create policy "clips change" on storage.objects for update to authenticated using (bucket_id = 'clips' and public.can_edit_path(name));
create policy "clips remove" on storage.objects for delete to authenticated using (bucket_id = 'clips' and public.can_edit_path(name));

-- ------------------------------------------------------------------ callouts (version 3.1)
-- Short clips recorded by a person (a singer saying "Let's do this!", "Last song!"…) that sessions
-- play next to the narration. The admin sets up the profiles and their clips; everyone signed in can
-- use the published ones. A profile can only be published once the admin confirms the person agreed.
create table if not exists public.callout_profiles (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 80),
  about        text not null default '',
  lang         text not null default 'is',
  consent      boolean not null default false,              -- the admin confirmed the person agreed
  published    boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint callout_published_needs_consent check (not published or consent)
);

-- Each clip is one take of one callout ("key"); a key can have several takes, picked at random.
create table if not exists public.callout_clips (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.callout_profiles(id) on delete cascade,
  key         text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  said        text not null default '',                    -- what is said, e.g. "Gerum þetta!"
  path        text not null,                               -- "<profile id>/<clip id>.<ext>" in the "callouts" bucket
  type        text not null default 'audio/mpeg',
  size        bigint not null default 0,
  duration_ms integer,
  created_at  timestamptz not null default now()
);
create index if not exists callout_clips_profile on public.callout_clips (profile_id);

-- How the person agreed (the admin's own record). Only the admin can read it.
create table if not exists public.callout_notes (
  profile_id   uuid primary key references public.callout_profiles(id) on delete cascade,
  consent_note text not null default '',
  updated_at   timestamptz not null default now()
);

create or replace function public.callout_visible(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from public.callout_profiles p where p.id = pid and p.published);
$$;
create or replace function public.callout_path_visible(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.callout_visible(split_part(object_name, '/', 1)::uuid)
    else false
  end;
$$;

alter table public.callout_profiles enable row level security;
alter table public.callout_clips    enable row level security;
alter table public.callout_notes    enable row level security;
drop policy if exists callout_read on public.callout_profiles;
drop policy if exists callout_admin on public.callout_profiles;
create policy callout_read  on public.callout_profiles for select to authenticated using (published or public.is_admin());
create policy callout_admin on public.callout_profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists callout_clip_read on public.callout_clips;
drop policy if exists callout_clip_admin on public.callout_clips;
create policy callout_clip_read  on public.callout_clips for select to authenticated using (public.callout_visible(profile_id));
create policy callout_clip_admin on public.callout_clips for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists callout_note_admin on public.callout_notes;
create policy callout_note_admin on public.callout_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.callout_profiles, public.callout_clips, public.callout_notes from anon;
grant select, insert, update, delete on public.callout_profiles, public.callout_clips, public.callout_notes to authenticated;
grant all on public.callout_profiles, public.callout_clips, public.callout_notes to service_role;
revoke all on function public.callout_visible(uuid), public.callout_path_visible(text) from public, anon;
grant execute on function public.callout_visible(uuid), public.callout_path_visible(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('callouts', 'callouts', false, 10485760)
on conflict (id) do nothing;
drop policy if exists "callouts read" on storage.objects;
drop policy if exists "callouts add" on storage.objects;
drop policy if exists "callouts change" on storage.objects;
drop policy if exists "callouts remove" on storage.objects;
create policy "callouts read"   on storage.objects for select to authenticated using (bucket_id = 'callouts' and public.callout_path_visible(name));
create policy "callouts add"    on storage.objects for insert to authenticated with check (bucket_id = 'callouts' and public.is_admin());
create policy "callouts change" on storage.objects for update to authenticated using (bucket_id = 'callouts' and public.is_admin());
create policy "callouts remove" on storage.objects for delete to authenticated using (bucket_id = 'callouts' and public.is_admin());

-- ------------------------------------------------------------------ moving to version 3 (one-time, safe to rerun)
-- 1. One person per space. Anyone who shared a space with its owner keeps every session in it,
--    now as a collaborator ("Shared by <owner>").
insert into public.session_shares (workspace_id, session_id, email, role, invited_by, invited_by_name)
select s.workspace_id, s.id, lower(m.email), 'editor', o.user_id, coalesce(nullif(o.name, ''), o.email)
from public.members m
join public.members o on o.workspace_id = m.workspace_id and o.role = 'owner'
join public.sessions s on s.workspace_id = m.workspace_id and not s.deleted
where m.role <> 'owner' and coalesce(m.email, '') <> ''
on conflict on constraint session_shares_pkey do nothing;
delete from public.members where role <> 'owner';
delete from public.invites;

-- 2. The first person to set up the app runs it.
insert into public.app_admins (user_id)
select w.created_by from public.workspaces w
where w.created_by is not null and not exists (select 1 from public.app_admins)
order by w.created_at limit 1;

-- 3. The ElevenLabs key moves out of reach of browsers: into app_secrets, used only by the "eleven" function.
insert into public.app_secrets (name, value)
select 'elevenlabs', w.settings ->> 'elKey'
from public.workspaces w join public.app_admins a on a.user_id = w.created_by
where coalesce(w.settings ->> 'elKey', '') <> ''
order by w.created_at limit 1
on conflict (name) do nothing;
update public.workspaces set settings = settings - 'elKey' - 'elKeyAt' where settings ? 'elKey' or settings ? 'elKeyAt';

-- 4. Shares made before roles existed name their owner.
update public.session_shares set owner_name = public.owner_name(workspace_id) where owner_name is null;
