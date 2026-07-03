-- Run this once in your Supabase project's SQL Editor (Supabase dashboard -> SQL Editor -> New query).
-- It creates the single table this app uses to store everything (teams, squads, transfers,
-- fixtures, auctions, chat, proof photos — all as JSON blobs under different keys), and turns
-- on Realtime so changes push to everyone instantly.

create table if not exists league_kv (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security is on by default for new Supabase tables. This app has no real user
-- accounts (it uses a simple admin PIN inside the app instead), so these policies just allow
-- anyone with your project's public "anon" key to read and write. That key is meant to be
-- shipped in client-side code — it's the same trust model as the app's admin PIN: fine for a
-- private league among friends, not a substitute for real authentication.
alter table league_kv enable row level security;

create policy "Public read access" on league_kv
  for select using (true);

create policy "Public write access" on league_kv
  for insert with check (true);

create policy "Public update access" on league_kv
  for update using (true);

create policy "Public delete access" on league_kv
  for delete using (true);

-- Turn on Realtime for this table so live sync actually pushes instantly instead of only polling.
alter publication supabase_realtime add table league_kv;
