-- M29 B2 — entitlements: the per-user paid-plan row.
--
-- POSTURE (mirrors backup-schema.sql's alert_deliveries): the client can
-- READ its own row and nothing else; only the service-role Stripe webhook
-- writes. There is deliberately NO insert/update/delete policy for anon or
-- authenticated — the webhook uses the service-role key, which bypasses RLS,
-- so write access exists exactly nowhere on the client side. A user cannot
-- grant themselves Pro by writing this table.
--
-- The runtime rarely reads this table: the app verifies a signed, cached
-- entitlement TOKEN (src/main/entitlements/token.ts) offline. This row is the
-- source of truth the webhook writes and the checkout/portal flows read; the
-- direct read is the fallback when a user has no cached token yet (first
-- launch after purchase on a new device).
--
-- Apply this on the NEW Supabase project as part of day-one provisioning
-- (docs/M29-cutover-runbook.md, docs/M29-supabase-migration-memo.md) — never
-- incrementally under time pressure (taxonomy species 23).

create table if not exists public.entitlements (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  plan                    text not null default 'free',
  status                  text not null default 'none',
  current_period_end      timestamptz,                 -- null = perpetual (one-time licence)
  seats                   int  not null default 1,     -- multi-seat not precluded (pricing Part G)
  org                     text,                         -- org slot reserved; null today
  managed_ai              boolean not null default false, -- reserved; nothing reads it today
  stripe_customer_id      text,
  stripe_subscription_id  text,
  updated_at              timestamptz not null default now()
);

alter table public.entitlements enable row level security;

-- Read your own row only.
drop policy if exists entitlements_read_own on public.entitlements;
create policy entitlements_read_own on public.entitlements
  for select using (user_id = auth.uid());

-- NO write policies on purpose: only the service-role webhook writes, and it
-- bypasses RLS. Do not add an insert/update/delete policy here.

-- Keep updated_at honest on webhook upserts.
create or replace function public.touch_entitlements_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_entitlements_touch on public.entitlements;
create trigger trg_entitlements_touch
  before update on public.entitlements
  for each row execute function public.touch_entitlements_updated_at();
