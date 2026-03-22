-- 001_category_submissions.sql
create table if not exists category_submissions (
  id uuid primary key default gen_random_uuid(),
  item_name text not null,
  category text not null check (category in ('meat', 'produce', 'bakery', 'dairy', 'drinks', 'grocery')),
  locale text not null check (locale in ('en', 'pt')),
  created_at timestamptz not null default now()
);

-- RLS: anonymous users can only INSERT
alter table category_submissions enable row level security;

create policy "anon_insert" on category_submissions
  for insert to anon
  with check (true);

-- No select/update/delete policies for anon = denied by default
-- Note: service_role (used by sync script) bypasses RLS automatically — no explicit SELECT policy needed
