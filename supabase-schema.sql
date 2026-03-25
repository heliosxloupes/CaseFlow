-- CaseFlow — Supabase Schema
-- Run this in your Supabase project: Dashboard → SQL Editor → New Query → paste → Run

-- ── user_settings ─────────────────────────────────────────────────────────
-- One row per user. Stores the encrypted ACGME credential vault (JSON blob).
-- The vault is encrypted client-side with AES-GCM before being stored here,
-- so even Supabase cannot read the plaintext ACGME credentials.

create table if not exists user_settings (
  user_id   uuid references auth.users(id) on delete cascade primary key,
  acgme_vault jsonb,
  updated_at  timestamptz default now()
);

alter table user_settings enable row level security;

create policy "Users can read own settings"
  on user_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert own settings"
  on user_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update own settings"
  on user_settings for update
  using (auth.uid() = user_id);


-- ── cases ──────────────────────────────────────────────────────────────────
-- One row per submitted case. Synced from the app on every submit.
-- Also acts as the source of truth for History across devices.

create table if not exists cases (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete cascade not null,
  local_id   text,          -- client-side timestamp ID for dedup
  date       date,
  procs      jsonb,         -- [{c, d, a}]
  role       text,
  site       text,
  att        text,
  pt         text,
  yr         text,
  notes      text,
  status     text default 'pending',
  ts         timestamptz default now()
);

alter table cases enable row level security;

create policy "Users can read own cases"
  on cases for select
  using (auth.uid() = user_id);

create policy "Users can insert own cases"
  on cases for insert
  with check (auth.uid() = user_id);

create policy "Users can update own cases"
  on cases for update
  using (auth.uid() = user_id);

create policy "Users can delete own cases"
  on cases for delete
  using (auth.uid() = user_id);

-- Index for fast per-user case queries
create index if not exists cases_user_id_idx on cases (user_id, ts desc);
