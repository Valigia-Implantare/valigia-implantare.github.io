-- Valigia Implantare: schema del database.
-- Da incollare una volta sola in Supabase → SQL Editor → New query → Run.
-- Si può rieseguire senza perdere dati.

-- Email autorizzate a usare l'app
create table if not exists public.accessi (
  email text primary key,
  aggiunto_il timestamptz not null default now()
);

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accessi
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_allowed() to anon, authenticated;

create table if not exists public.linee (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.dottori (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.stock (
  id text primary key,
  line_id text not null references public.linee(id) on delete cascade,
  d numeric not null,
  l numeric not null,
  qty integer not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.prenotazioni (
  id text primary key,
  nome text not null,
  cognome text not null,
  data text not null default '',
  sede text,
  dottore_id text,
  dottore text,
  note text not null default '',
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.registro (
  id text primary key,
  nome text,
  cognome text,
  sede text,
  dottore text,
  dottore_id text,
  line_id text,
  linea text,
  d numeric,
  l numeric,
  stock_id text,
  data text,
  data_prevista text,
  note text,
  created_at timestamptz not null default now(),
  created_by text
);

-- Solo gli utenti con email in "accessi" leggono e scrivono
do $$
declare t text;
begin
  foreach t in array array['accessi','linee','dottori','stock','prenotazioni','registro'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "solo autorizzati" on public.%I', t);
    execute format('create policy "solo autorizzati" on public.%I for all to authenticated using (public.is_allowed()) with check (public.is_allowed())', t);
  end loop;
end $$;

-- Aggiornamenti in tempo reale
do $$
declare t text;
begin
  foreach t in array array['accessi','linee','dottori','stock','prenotazioni','registro'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Primo accesso autorizzato (gli altri si aggiungono dall'app, scheda Elenchi → Accessi)
insert into public.accessi (email) values ('pierpaolomancin@gmail.com') on conflict do nothing;

-- Dati già inseriti nella versione di prova
insert into public.linee (id, name, created_at) values
  ('lmumnzemd7cvg', 'JD Evolution',  '2026-09-29T12:40:19Z'),
  ('lmumnzohq7yak', 'NUVO Standard', '2026-09-29T12:40:31Z')
on conflict do nothing;

insert into public.dottori (id, name, created_at) values
  ('dmumnz0q7l4cl', 'Dott. Alessandro Mancin', '2026-09-29T12:40:01Z'),
  ('dmumo2p5skn0n', 'Dott. Francesco Mancin',  '2026-09-29T12:42:52Z')
on conflict do nothing;

insert into public.stock (id, line_id, d, l, qty) values
  ('lmumnzemd7cvg_2.7_12', 'lmumnzemd7cvg', 2.7, 12, 1),
  ('lmumnzemd7cvg_4.1_10', 'lmumnzemd7cvg', 4.1, 10, 7),
  ('lmumnzohq7yak_3.7_10', 'lmumnzohq7yak', 3.7, 10, 5),
  ('lmumnzohq7yak_4.2_11', 'lmumnzohq7yak', 4.2, 11, 1)
on conflict do nothing;
