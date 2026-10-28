create table if not exists public.mm_events (
  id bigint generated always as identity primary key,
  campaign uuid not null,
  recipient text not null,
  type text not null check (type in ('open', 'click')),
  url text,
  created_at timestamptz not null default now()
);
create index if not exists mm_events_campaign_idx on public.mm_events (campaign);

-- Only the edge function (service role) reads and writes this table.
alter table public.mm_events enable row level security;
