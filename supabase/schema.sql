-- =====================================================================
-- Dataset Collector — skema database Supabase (v3)
-- • Login username. Akun pertama = admin; akun lain dibuat admin.
-- • Dua peran: admin (kelola proyek & anggota) dan anggota (ambil foto + verifikasi).
-- • Setiap proyek hanya bisa dibuka anggotanya. Admin melihat semua proyek.
-- • ID objek otomatis atau diketik sendiri.
-- • Status kirim ke Roboflow dicatat per foto (diisi Edge Function roboflow-sync).
--
-- Jalankan: Supabase → SQL Editor → New query → tempel seluruh isi → Run.
-- Aman dijalankan ulang, dan aman dijalankan di atas skema v2 (data tetap).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Domain internal: username "budi" disimpan di Supabase Auth sebagai budi@<domain>.
-- Tidak pernah dipakai mengirim email. Harus sama dengan loginDomain di config.js.
create or replace function public.login_domain() returns text language sql immutable as $$ select 'dataset-collector.app'::text $$;

-- ---------- Tabel ----------
create table if not exists public.profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  username          text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  full_name         text not null default '',
  role              text not null,
  photographer_code text not null unique check (photographer_code ~ '^[A-Z0-9]{2,10}$'),
  active            boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- migrasi peran v2 (pengumpul/pemeriksa) → anggota
alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = 'anggota' where role in ('pengumpul','pemeriksa');
alter table public.profiles add constraint profiles_role_check check (role in ('admin','anggota'));

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  added_by    uuid default auth.uid(),
  added_at    timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user on public.project_members(user_id);

-- Kunci API Roboflow per proyek. Tidak bisa dibaca dari aplikasi (tanpa policy select);
-- hanya Edge Function (secret key) yang membacanya.
create table if not exists public.project_secrets (
  project_id        uuid primary key references public.projects(id) on delete cascade,
  roboflow_api_key  text,
  updated_at        timestamptz not null default now()
);

create table if not exists public.counters (
  project_id  uuid primary key references public.projects(id) on delete cascade,
  last_number int  not null default 0
);

create table if not exists public.object_groups (
  project_id  uuid not null references public.projects(id) on delete cascade,
  id          text not null check (id ~ '^[0-9]{4}$' and id <> '0000'),
  category    text not null,
  last_rep    int  not null default 0,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project_id, id)
);

create table if not exists public.images (
  project_id          uuid not null references public.projects(id) on delete cascade,
  id                  text not null,
  group_id            text not null,
  filename            text not null check (filename ~ '^[a-z0-9]+_[a-z0-9]+_[a-z0-9]+_[0-9]{8}_[A-Z0-9]+_[0-9]{4}_[1-9][0-9]*\.jpg$'),
  repetition_number   int  not null check (repetition_number >= 1),
  verification_status text not null default 'pending' check (verification_status in ('pending','verified','flagged')),
  data                jsonb not null,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (project_id, id),
  unique (project_id, filename),
  unique (project_id, group_id, repetition_number),
  foreign key (project_id, group_id) references public.object_groups(project_id, id) on delete restrict
);
create index if not exists images_group on public.images(project_id, group_id);
alter table public.images add column if not exists roboflow_status text;
alter table public.images add column if not exists roboflow_id     text;
alter table public.images add column if not exists roboflow_error  text;
alter table public.images add column if not exists roboflow_at     timestamptz;

-- ---------- Peran & keanggotaan ----------
create or replace function public.role_rank(r text) returns int language sql immutable as $$
  select case r when 'admin' then 2 when 'anggota' then 1 else 0 end $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid() and active $$;

create or replace function public.has_role(min_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.role_rank(public.my_role()) >= public.role_rank(min_role) $$;

-- admin aktif, atau anggota aktif yang terdaftar di proyek
create or replace function public.is_member(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin')
      or (public.has_role('anggota') and exists (select 1 from public.project_members m where m.project_id = p and m.user_id = auth.uid())) $$;

create or replace function public.valid_ymd(p text) returns boolean language plpgsql immutable as $$
begin
  if p is null or p !~ '^[0-9]{8}$' then return false; end if;
  return to_char(to_date(p,'YYYYMMDD'),'YYYYMMDD') = p and substr(p,1,4)::int between 2000 and 2100;
exception when others then return false;
end $$;

-- ---------- Akun ----------
create or replace function public._create_auth_user(p_username text, p_password text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := gen_random_uuid(); v_email text := p_username || '@' || public.login_domain();
begin
  if p_username is null or p_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'Username 3–30 karakter: huruf kecil, angka, titik, garis bawah, atau strip.';
  end if;
  if length(coalesce(p_password,'')) < 8 then raise exception 'Kata sandi minimal 8 karakter.'; end if;
  if exists (select 1 from public.profiles where username = p_username) or exists (select 1 from auth.users where email = v_email) then
    raise exception 'Username % sudah dipakai.', p_username;
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', p_username), now(), now(),
          '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());
  return v_id;
end $$;
revoke all on function public._create_auth_user(text,text) from public, anon, authenticated;

create or replace function public.needs_setup() returns boolean
language sql stable security definer set search_path = public as $$ select not exists (select 1 from public.profiles) $$;

create or replace function public.setup_admin(p_username text, p_password text, p_full_name text, p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_user text := lower(trim(p_username)); v_code text := upper(trim(p_code));
begin
  lock table public.profiles in exclusive mode;
  if exists (select 1 from public.profiles) then raise exception 'Akun admin sudah dibuat. Silakan masuk.'; end if;
  if v_code !~ '^[A-Z0-9]{2,10}$' then raise exception 'Kode fotografer 2–10 huruf besar atau angka, misalnya FA01.'; end if;
  v_id := public._create_auth_user(v_user, p_password);
  insert into public.profiles(user_id, username, full_name, role, photographer_code, active, created_by)
  values (v_id, v_user, trim(coalesce(p_full_name,'')), 'admin', v_code, true, v_id);
  return v_id;
end $$;

drop function if exists public.admin_create_user(text,text,text,text,text);
create or replace function public.admin_create_user(p_username text, p_password text, p_full_name text, p_role text, p_code text, p_projects uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_user text := lower(trim(p_username)); v_code text := upper(trim(p_code));
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat menambah pengguna.'; end if;
  if p_role not in ('admin','anggota') then raise exception 'Peran tidak valid.'; end if;
  if v_code !~ '^[A-Z0-9]{2,10}$' then raise exception 'Kode fotografer 2–10 huruf besar atau angka, misalnya FA02.'; end if;
  if exists (select 1 from public.profiles where photographer_code = v_code) then raise exception 'Kode fotografer % sudah dipakai.', v_code; end if;
  v_id := public._create_auth_user(v_user, p_password);
  insert into public.profiles(user_id, username, full_name, role, photographer_code, active, created_by)
  values (v_id, v_user, trim(coalesce(p_full_name,'')), p_role, v_code, true, auth.uid());
  insert into public.project_members(project_id, user_id)
  select p.id, v_id from public.projects p where p.id = any(coalesce(p_projects,'{}')) on conflict do nothing;
  return v_id;
end $$;

create or replace function public.admin_update_user(p_user uuid, p_full_name text, p_role text, p_code text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles; v_code text := upper(trim(p_code));
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat mengubah pengguna.'; end if;
  select * into cur from public.profiles where user_id = p_user for update;
  if not found then raise exception 'Pengguna tidak ditemukan.'; end if;
  if p_role not in ('admin','anggota') then raise exception 'Peran tidak valid.'; end if;
  if v_code !~ '^[A-Z0-9]{2,10}$' then raise exception 'Kode fotografer 2–10 huruf besar atau angka.'; end if;
  if p_user = auth.uid() and (not p_active or p_role <> 'admin') then raise exception 'Anda tidak dapat menonaktifkan atau menurunkan peran akun sendiri.'; end if;
  if cur.role = 'admin' and cur.active and (p_role <> 'admin' or not p_active)
     and (select count(*) from public.profiles where role = 'admin' and active) <= 1 then
    raise exception 'Harus ada minimal satu admin aktif.';
  end if;
  if exists (select 1 from public.profiles where photographer_code = v_code and user_id <> p_user) then raise exception 'Kode fotografer % sudah dipakai.', v_code; end if;
  update public.profiles set full_name = trim(coalesce(p_full_name,'')), role = p_role, photographer_code = v_code, active = p_active, updated_at = now() where user_id = p_user;
end $$;

create or replace function public.admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat mengatur ulang kata sandi.'; end if;
  if length(coalesce(p_password,'')) < 8 then raise exception 'Kata sandi minimal 8 karakter.'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  if not found then raise exception 'Pengguna tidak ditemukan.'; end if;
end $$;

create or replace function public.admin_delete_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles;
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat menghapus pengguna.'; end if;
  if p_user = auth.uid() then raise exception 'Anda tidak dapat menghapus akun sendiri.'; end if;
  select * into cur from public.profiles where user_id = p_user;
  if not found then raise exception 'Pengguna tidak ditemukan.'; end if;
  if cur.role = 'admin' and cur.active and (select count(*) from public.profiles where role = 'admin' and active) <= 1 then
    raise exception 'Harus ada minimal satu admin aktif.';
  end if;
  delete from auth.users where id = p_user;
end $$;

-- ---------- RLS ----------
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.project_secrets enable row level security;
alter table public.counters        enable row level security;
alter table public.object_groups   enable row level security;
alter table public.images          enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (public.has_role('anggota'));
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated using (public.is_member(id));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated using (public.has_role('admin'));
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members for select to authenticated using (public.has_role('admin') or user_id = auth.uid());
drop policy if exists counters_select on public.counters;
create policy counters_select on public.counters for select to authenticated using (public.is_member(project_id));
drop policy if exists groups_select on public.object_groups;
create policy groups_select on public.object_groups for select to authenticated using (public.is_member(project_id));
drop policy if exists images_select on public.images;
create policy images_select on public.images for select to authenticated using (public.is_member(project_id));

revoke all on public.profiles, public.projects, public.project_members, public.project_secrets, public.counters, public.object_groups, public.images from anon;
revoke all on public.project_secrets from authenticated;
revoke insert, update, delete on public.profiles, public.project_members, public.counters, public.object_groups, public.images from authenticated;
revoke insert on public.projects from authenticated;

-- ---------- Proyek ----------
create or replace function public.create_project(p_name text, p_data jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat membuat proyek.'; end if;
  insert into public.projects(name, data, created_by) values (coalesce(nullif(trim(p_name),''),'Proyek baru'), coalesce(p_data,'{}'::jsonb), auth.uid()) returning id into v_id;
  insert into public.counters(project_id) values (v_id);
  insert into public.project_members(project_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
  return v_id;
end $$;

-- Atur daftar anggota proyek (menggantikan seluruh daftar).
create or replace function public.set_project_members(p_project uuid, p_users uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat mengatur anggota proyek.'; end if;
  if not exists (select 1 from public.projects where id = p_project) then raise exception 'Proyek tidak ditemukan.'; end if;
  delete from public.project_members where project_id = p_project and not (user_id = any(coalesce(p_users,'{}')));
  insert into public.project_members(project_id, user_id)
  select p_project, u.user_id from public.profiles u where u.user_id = any(coalesce(p_users,'{}')) on conflict do nothing;
  select count(*) into n from public.project_members where project_id = p_project;
  return n;
end $$;

-- Atur proyek yang boleh dibuka satu pengguna (menggantikan seluruh daftar).
create or replace function public.set_user_projects(p_user uuid, p_projects uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat mengatur akses proyek.'; end if;
  if not exists (select 1 from public.profiles where user_id = p_user) then raise exception 'Pengguna tidak ditemukan.'; end if;
  delete from public.project_members where user_id = p_user and not (project_id = any(coalesce(p_projects,'{}')));
  insert into public.project_members(project_id, user_id)
  select p.id, p_user from public.projects p where p.id = any(coalesce(p_projects,'{}')) on conflict do nothing;
  select count(*) into n from public.project_members where user_id = p_user;
  return n;
end $$;

create or replace function public.set_roboflow_key(p_project uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat mengatur kunci Roboflow.'; end if;
  insert into public.project_secrets(project_id, roboflow_api_key, updated_at) values (p_project, nullif(trim(p_key),''), now())
  on conflict (project_id) do update set roboflow_api_key = excluded.roboflow_api_key, updated_at = now();
end $$;

create or replace function public.has_roboflow_key(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(p_project) and exists (select 1 from public.project_secrets where project_id = p_project and coalesce(roboflow_api_key,'') <> '') $$;

-- ---------- Foto ----------
-- Simpan satu foto. Nomor ID objek & ulangan ditetapkan di dalam transaksi dengan penguncian.
--   p_group  : ID objek yang difoto ulang (atau null)
--   p_code   : ID objek yang diketik sendiri (atau null). Jika ID sudah ada → foto ulang objek itu;
--              jika belum ada → objek baru dengan ID tersebut.
--   keduanya null → objek baru dengan ID berikutnya (otomatis).
drop function if exists public.save_image(uuid,text,text,text,text,text,jsonb);
create or replace function public.save_image(p_project uuid, p_group text, p_category text, p_location text,
                                             p_lighting text, p_date text, p_row jsonb, p_code text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles; prj public.projects; g public.object_groups; n int; v_rep int; v_prefix text; v_name text;
  v_id text; v_row jsonb; v_now timestamptz := now(); v_cats text[]; v_lights text[]; v_target text;
begin
  select * into me from public.profiles where user_id = auth.uid() and active;
  if not found then raise exception 'Akun Anda tidak aktif. Hubungi admin.'; end if;
  if not public.is_member(p_project) then raise exception 'Anda bukan anggota proyek ini.'; end if;
  select * into prj from public.projects where id = p_project;
  if not found then raise exception 'Proyek tidak ditemukan.'; end if;
  select array_agg(c->>'code') into v_cats from jsonb_array_elements(prj.data->'categories') c where coalesce((c->>'active')::boolean, true);
  select array_agg(l->>'code') into v_lights from jsonb_array_elements(prj.data->'lightings') l;
  if p_location is null or p_location !~ '^[a-z0-9]{1,40}$' then raise exception 'Lokasi wajib diisi, hanya huruf kecil dan angka tanpa spasi.'; end if;
  if p_lighting is null or not (p_lighting = any(coalesce(v_lights, array['in','out']))) then raise exception 'Kondisi cahaya tidak terdaftar.'; end if;
  if not public.valid_ymd(p_date) then raise exception 'Tanggal pengambilan tidak valid.'; end if;

  insert into public.counters(project_id) values (p_project) on conflict (project_id) do nothing;
  v_target := coalesce(nullif(p_group,''), nullif(trim(p_code),''));
  if v_target is not null then
    if v_target ~ '^[0-9]{1,4}$' then v_target := lpad(v_target, 4, '0'); end if;
    if v_target !~ '^[0-9]{4}$' or v_target = '0000' then raise exception 'ID objek harus angka 0001–9999.'; end if;
    perform 1 from public.counters where project_id = p_project for update;
    select * into g from public.object_groups where project_id = p_project and id = v_target for update;
    if not found then
      if p_group is not null then raise exception 'Objek yang dipilih sudah tidak ada.'; end if;
      if p_category is null or not (p_category = any(v_cats)) then raise exception 'Kategori tidak terdaftar di proyek.'; end if;
      insert into public.object_groups(project_id, id, category) values (p_project, v_target, p_category) returning * into g;
      update public.counters set last_number = greatest(last_number, v_target::int) where project_id = p_project;
    end if;
  else
    if p_category is null or not (p_category = any(v_cats)) then raise exception 'Kategori tidak terdaftar di proyek.'; end if;
    update public.counters
       set last_number = greatest(last_number, coalesce((select max(id::int) from public.object_groups where project_id = p_project), 0)) + 1
     where project_id = p_project returning last_number into n;
    if n > 9999 then raise exception 'ID objek sudah mencapai 9999.'; end if;
    insert into public.object_groups(project_id, id, category) values (p_project, lpad(n::text, 4, '0'), p_category) returning * into g;
  end if;

  v_prefix := g.category || '_' || p_location || '_' || p_lighting || '_' || p_date || '_' || me.photographer_code;
  v_rep := greatest(g.last_rep, coalesce((select max(repetition_number) from public.images where project_id = p_project and group_id = g.id), 0)) + 1;
  loop
    v_name := v_prefix || '_' || g.id || '_' || v_rep || '.jpg';
    exit when not exists (select 1 from public.images where project_id = p_project and filename = v_name);
    v_rep := v_rep + 1;
  end loop;

  v_id  := coalesce(nullif(p_row->>'id',''), gen_random_uuid()::text);
  v_row := coalesce(p_row,'{}'::jsonb) || jsonb_build_object(
    'id', v_id, 'project_id', p_project, 'group_id', g.id, 'object_code', g.id, 'repetition_number', v_rep,
    'filename', v_name, 'file_path', 'images/' || v_name, 'category_confirmed', g.category,
    'location', p_location, 'lighting', p_lighting, 'capture_date', p_date, 'photographer_code', me.photographer_code,
    'created_by_username', me.username, 'verification_status', 'pending', 'created_at', v_now);
  insert into public.images(project_id, id, group_id, filename, repetition_number, verification_status, data)
  values (p_project, v_id, g.id, v_name, v_rep, 'pending', v_row);
  update public.object_groups set last_rep = v_rep, updated_at = v_now where project_id = p_project and id = g.id;
  return v_row;
end $$;

create or replace function public.set_status(p_project uuid, p_ids text[], p_status text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; v_user text := (select username from public.profiles where user_id = auth.uid());
begin
  if not public.is_member(p_project) then raise exception 'Anda bukan anggota proyek ini.'; end if;
  if p_status not in ('pending','verified','flagged') then raise exception 'Status tidak valid.'; end if;
  update public.images set verification_status = p_status, updated_at = now(),
         data = data || jsonb_build_object('verification_status', p_status, 'reviewed_at', now(), 'reviewed_by', v_user)
   where project_id = p_project and id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.relabel_group(p_project uuid, p_group text, p_category text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; v_cats text[];
begin
  if not public.is_member(p_project) then raise exception 'Anda bukan anggota proyek ini.'; end if;
  select array_agg(c->>'code') into v_cats from public.projects p, jsonb_array_elements(p.data->'categories') c where p.id = p_project;
  if not (p_category = any(v_cats)) then raise exception 'Kategori tidak terdaftar di proyek.'; end if;
  perform 1 from public.object_groups where project_id = p_project and id = p_group for update;
  if not found then raise exception 'Objek tidak ditemukan.'; end if;
  begin
    update public.images
       set filename = p_category || substr(filename, position('_' in filename)), updated_at = now(),
           data = data || jsonb_build_object('category_confirmed', p_category, 'category_source', 'koreksi_pemeriksa', 'label_updated_at', now(),
             'filename',  p_category || substr(filename, position('_' in filename)),
             'file_path', 'images/' || p_category || substr(filename, position('_' in filename)))
     where project_id = p_project and group_id = p_group;
  exception when unique_violation then
    raise exception 'Nama berkas baru bentrok dengan berkas lain. Koreksi dibatalkan.';
  end;
  get diagnostics n = row_count;
  update public.object_groups set category = p_category, updated_at = now() where project_id = p_project and id = p_group;
  return n;
end $$;

create or replace function public.delete_image(p_project uuid, p_id text) returns text
language plpgsql security definer set search_path = public as $$
declare v_asset text;
begin
  if not public.has_role('admin') then raise exception 'Hanya admin yang dapat menghapus foto.'; end if;
  delete from public.images where project_id = p_project and id = p_id returning data->>'asset_id' into v_asset;
  return v_asset;
end $$;

-- ---------- Hak eksekusi ----------
revoke all on function public.setup_admin(text,text,text,text), public.needs_setup(),
  public.admin_create_user(text,text,text,text,text,uuid[]), public.admin_update_user(uuid,text,text,text,boolean),
  public.admin_set_password(uuid,text), public.admin_delete_user(uuid), public.create_project(text,jsonb),
  public.set_project_members(uuid,uuid[]), public.set_user_projects(uuid,uuid[]), public.set_roboflow_key(uuid,text), public.has_roboflow_key(uuid),
  public.save_image(uuid,text,text,text,text,text,jsonb,text), public.set_status(uuid,text[],text),
  public.relabel_group(uuid,text,text), public.delete_image(uuid,text), public.my_role(), public.has_role(text),
  public.is_member(uuid) from public, anon;
grant execute on function public.needs_setup(), public.setup_admin(text,text,text,text) to anon, authenticated;
grant execute on function public.admin_create_user(text,text,text,text,text,uuid[]), public.admin_update_user(uuid,text,text,text,boolean),
  public.admin_set_password(uuid,text), public.admin_delete_user(uuid), public.create_project(text,jsonb),
  public.set_project_members(uuid,uuid[]), public.set_user_projects(uuid,uuid[]), public.set_roboflow_key(uuid,text), public.has_roboflow_key(uuid),
  public.save_image(uuid,text,text,text,text,text,jsonb,text), public.set_status(uuid,text[],text),
  public.relabel_group(uuid,text,text), public.delete_image(uuid,text), public.my_role(), public.has_role(text),
  public.is_member(uuid) to authenticated;

-- ---------- Penyimpanan foto (bucket privat "photos", folder = id proyek) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

create or replace function public.photo_member(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_project uuid;
begin
  begin v_project := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  return public.is_member(v_project);
end $$;
grant execute on function public.photo_member(text) to authenticated;

drop policy if exists "photos_select" on storage.objects;
create policy "photos_select" on storage.objects for select to authenticated using (bucket_id = 'photos' and public.photo_member(name));
drop policy if exists "photos_insert" on storage.objects;
create policy "photos_insert" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.photo_member(name));
drop policy if exists "photos_delete" on storage.objects;
create policy "photos_delete" on storage.objects for delete to authenticated using (bucket_id = 'photos' and (public.has_role('admin') or (owner_id = auth.uid()::text and public.photo_member(name))));

-- ---------- Sinkronisasi langsung (Realtime) ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','projects','project_members','counters','object_groups','images'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; when undefined_object then null; end;
  end loop;
end $$;
