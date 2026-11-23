-- Cancelling and deleting tournaments.
--
--  * Delete: only a tournament with nothing on record. No registration that
--    paid, waits on the waitlist, was refunded or is checking out right now,
--    nothing on the books, and no fee paid to Courtside. A draft has none
--    (unless it was opened and moved back). Who, as before: the
--    organization's owners and admins; a standalone Basic tournament's admins.
--  * Cancel: any of its managers. The tournament is archived: hidden from the
--    public (its link shows only its name and the announcement), closed to
--    registration and play, and kept for its managers to see and edit.
--    The announcement says it's cancelled and is emailed to its players.
--    Unpaid and waitlisted registrations are cancelled, and each player's
--    entry fees are credited, so what they paid shows as owed to them.
--    Refunds aren't sent by themselves: managers send them from the
--    tournament's Overview (refunds_due).

alter table public.tournaments add column cancelled_at timestamptz;

-- ---------------------------------------------------------------------------
-- Delete
-- ---------------------------------------------------------------------------

-- Nothing on record that deleting would lose.
create function public.tournament_deletable(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.registrations r
                     where r.tournament_id = p_tournament
                       and (r.status in ('paid', 'waitlisted', 'refunded')
                            -- A checkout lasts 31 minutes; one started in the last hour could still be paid.
                            or (r.status = 'pending' and r.created_at > private.clock() - interval '1 hour')))
     and not exists (select 1 from public.ledger_entries l where l.tournament_id = p_tournament)
     and not exists (select 1 from public.stripe_notices n where n.tournament_id = p_tournament)
     and not exists (select 1 from private.player_fee_payments f where f.tournament_id = p_tournament)
     and not exists (select 1 from private.platform_checkouts c
                     where c.tournament_id = p_tournament and c.created_at > private.clock() - interval '1 hour')
     and not exists (select 1 from public.tournaments t
                     where t.id = p_tournament and t.setup_paid_at is not null and not t.is_demo)
$$;

-- Who may delete it, as in the delete policies.
create function private.can_delete_tournament(t public.tournaments) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_organization_member(t.organization_id, array['owner', 'admin'])
      or (t.organization_id is null and public.is_tournament_staff(t.id))
$$;

drop policy "Organization admins delete tournaments" on public.tournaments;
create policy "Organization admins delete tournaments" on public.tournaments for delete to authenticated
  using (public.is_organization_member(organization_id, array['owner', 'admin']) and public.tournament_deletable(id));

drop policy "Standalone tournament admins delete it" on public.tournaments;
create policy "Standalone tournament admins delete it" on public.tournaments for delete to authenticated
  using (organization_id is null and public.is_tournament_staff(id) and public.tournament_deletable(id));

-- Staff, for Settings: {can_delete: they may, deletable: nothing on record}.
create function public.tournament_removal(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  return jsonb_build_object('can_delete', private.can_delete_tournament(t),
                            'deletable', public.tournament_deletable(p_tournament));
end $$;

-- The owner: deletes it for good, with everything in it. Saying why not, where
-- a delete through the policies would just delete nothing.
create function public.delete_tournament(p_tournament uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament;
  if not found or not public.is_tournament_staff(p_tournament) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if not private.can_delete_tournament(t) then
    raise exception 'Only the tournament''s owner can delete it' using errcode = '42501';
  end if;
  perform private.lock_tournament(p_tournament);
  if not public.tournament_deletable(p_tournament) then
    raise exception '% has registrations or payments on record, so it can''t be deleted. Cancel it instead.', t.name
      using errcode = '55000';
  end if;
  delete from public.tournaments where id = p_tournament;
end $$;

-- ---------------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------------

-- Staff: cancels it, with p_announcement (or "<name> is cancelled.") as its
-- announcement and the email to its players.
create function public.cancel_tournament(p_tournament uuid, p_announcement text default null) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  v_text text := nullif(btrim(p_announcement), '');
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  if t.status = 'cancelled' then
    raise exception '% is already cancelled', t.name using errcode = '55000';
  end if;
  if t.status = 'complete' then
    raise exception '% is over, so it can''t be cancelled', t.name using errcode = '55000';
  end if;
  v_text := coalesce(v_text, t.name || ' is cancelled.');
  if length(v_text) > 500 then
    raise exception 'Keep the announcement to 500 characters' using errcode = '22023';
  end if;

  -- Everyone registered or on a team hears it, the waitlist too.
  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  select p_tournament, x.player_id, 'tournament_cancelled', 'email', t.name || ' is cancelled', v_text
  from (select r.player_id from public.registrations r
        where r.tournament_id = p_tournament and r.status in ('paid', 'waitlisted')
        union
        select tp.player_id from public.team_players tp join public.teams tm on tm.id = tp.team_id
        where tm.tournament_id = p_tournament and tm.withdrawn_at is null) x;

  -- Nothing paid, nothing to refund. A checkout that finishes after this
  -- can't apply, so it shows in Stripe notices to be refunded.
  update public.registrations set status = 'cancelled'
  where tournament_id = p_tournament and status in ('pending', 'waitlisted');

  -- The entry fees still charged, taken off: what they paid is now owed back.
  insert into public.ledger_entries (tournament_id, player_id, kind, amount_cents, note, created_at)
  select b.tournament_id, b.player_id, 'credit',
         -(b.entry_fees_cents - b.discount_cents - b.withdrawal_credit_cents - b.credits_cents),
         'Tournament cancelled', private.clock()
  from public.player_balances b
  where b.tournament_id = p_tournament
    and b.entry_fees_cents - b.discount_cents - b.withdrawal_credit_cents - b.credits_cents > 0;

  update public.tournaments
  set status = 'cancelled', cancelled_at = private.clock(), announcement = v_text
  where id = p_tournament
  returning * into t;
  return t;
end $$;

-- No new registrations, and no withdrawal credits on top of the cancellation's.
create function private.refuse_when_cancelled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tournaments t where t.id = new.tournament_id and t.status = 'cancelled') then
    raise exception 'This tournament is cancelled' using errcode = '55000';
  end if;
  return new;
end $$;

create trigger registrations_not_cancelled before insert on public.registrations
for each row execute function private.refuse_when_cancelled();
create trigger ledger_not_cancelled before insert on public.ledger_entries
for each row when (new.kind in ('entry_fees', 'withdrawal')) execute function private.refuse_when_cancelled();

-- As before (platform_fees). Nothing moves a cancelled tournament (starting a
-- division comes here too), and only cancel_tournament cancels.
create or replace function public.set_tournament_status(p_tournament uuid, p_status public.tournament_status)
returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  if t.status = 'cancelled' then
    raise exception '% is cancelled', t.name using errcode = '55000';
  end if;
  if p_status = 'cancelled' then
    raise exception 'Cancel a tournament from Settings → Cancel tournament' using errcode = '22023';
  end if;
  if p_status in ('registration', 'live') and private.setup_fee_due(t) > 0 then
    raise exception 'Pay the % setup fee to open this tournament (Setup → Fees)',
      to_char(private.setup_fee_due(t) / 100.0, 'FM$999,990.00') using errcode = '55000';
  end if;
  update public.tournaments set status = p_status where id = p_tournament returning * into t;
  perform private.auto_assign(p_tournament);
  return t;
end $$;

-- Anyone: a cancelled tournament's name and announcement, for its link.
create function public.cancelled_tournament(p_tournament uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'starts_on', t.starts_on, 'time_zone', t.time_zone,
                            'announcement', t.announcement, 'cancelled_at', t.cancelled_at)
  from public.tournaments t where t.id = p_tournament and t.status = 'cancelled'
$$;

-- Staff: everyone the tournament owes money, with what of it can go back to
-- their card (as in card_refund_plan).
create function public.refunds_due(p_tournament uuid)
returns table (player_id uuid, name text, email text, owed_cents int, card_cents int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  select b.player_id, p.first_name || ' ' || p.last_name, p.email::text, -b.balance_cents,
         coalesce((
           select sum(r.amount_cents - coalesce((
                    select sum(l.amount_cents) from public.ledger_entries l
                    where l.registration_id = r.id and l.kind = 'refund' and l.stripe_refund_id is not null), 0))
           from public.registrations r
           where r.tournament_id = p_tournament and r.player_id = b.player_id and r.status = 'paid'
             and r.payment_provider in ('stripe', 'test') and r.payment_ref is not null and r.amount_cents > 0
         ), 0)::int
  from public.player_balances b
  join public.players p on p.id = b.player_id
  where b.tournament_id = p_tournament and b.balance_cents < 0
  order by p.last_name, p.first_name;
end $$;

-- As before (one_account), plus refunds_due: how many players a cancelled
-- tournament still owes.
drop function public.my_tournaments();
create function public.my_tournaments()
returns table (id uuid, name text, starts_on date, status public.tournament_status, role text, refunds_due int)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, t.starts_on, t.status,
         case when t.created_by = auth.uid() then 'owner'
              when exists (select 1 from public.organization_members om
                           where om.organization_id = t.organization_id and om.user_id = auth.uid()) then 'admin'
              else (select s.role from public.tournament_staff s where s.tournament_id = t.id and s.user_id = auth.uid())
         end,
         case when t.status = 'cancelled' and public.is_tournament_staff(t.id)
              then (select count(*)::int from public.player_balances b where b.tournament_id = t.id and b.balance_cents < 0)
              else 0 end
  from public.tournaments t
  where public.is_court_monitor(t.id)
  order by t.starts_on desc, t.name
  limit 100
$$;

-- ---------------------------------------------------------------------------
-- Hidden from the public, like a draft
-- ---------------------------------------------------------------------------

drop policy "Visible tournaments" on public.tournaments;
create policy "Visible tournaments" on public.tournaments for select to anon, authenticated
  using (status not in ('draft', 'cancelled') or public.is_tournament_staff(id));

-- As before (match_tags), hidden when cancelled.
create or replace function public.up_next(p_tournament uuid)
returns table (
  queue_rank int,
  match_id uuid,
  event_id uuid,
  event_name text,
  label text,
  team1_id uuid,
  team1_name text,
  team2_id uuid,
  team2_name text,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz,
  court_names text[],
  championship boolean,
  waiting_for_court text,
  wait_until timestamptz,
  stage text,
  round_key text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_now timestamptz := private.clock();
  v_free uuid[];
  v_champ uuid[];
  v_main text;
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status not in ('draft', 'cancelled') or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  v_free := private.free_courts(p_tournament);
  v_champ := private.championship_courts(p_tournament);
  select c.name into v_main from public.courts c where c.id = v_champ[1];

  return query
  with ready as (
    select r.*, tn.championship_mode = 'wait' and not r.expired as waits
    from private.championship_ready(p_tournament, v_now) r
    join public.tournaments tn on tn.id = p_tournament
  ),
  waiting as (
    select r.match_id, r.is_final, r.wait_until
    from ready r
    where r.waits
      and case when r.is_final then not (v_champ[1] = any (v_free))
               else not (v_champ && v_free) end
  ),
  rows as (
    select q.queue_rank as rank, m.id, e.id as event_id, e.name, m.label, t1.id as t1, t1.name as t1_name,
           t2.id as t2, t2.name as t2_name,
           case when w.match_id is not null then 'waiting_for_championship_court' else q.blocked_reason end as reason,
           q.overdue, q.waiting_since,
           array(
             select c.name from public.courts c
             where c.id = any (e.court_ids) and c.retired_at is null
             order by c.sort_order, c.name
           ) as court_names,
           cardinality(v_champ) > 0 and m.stage = 'bracket' and m.round_key = any (tn.championship_rounds)
             and private.championship_weight(m.round_key) > 0 as championship,
           case when w.is_final then v_main end as waiting_for_court,
           w.wait_until,
           -- Sent ahead of the queue: biggest round, then longest ready.
           case when rd.match_id is not null and not rd.waits then rd.weight end as ahead_weight,
           rd.ready_since as ahead_since,
           m.stage::text as stage,
           m.round_key::text as round_key
    from private.plan_queue(p_tournament, v_now) q
    join public.matches m on m.id = q.match_id
    join public.events e on e.id = m.event_id
    join public.tournaments tn on tn.id = m.tournament_id
    join public.teams t1 on t1.id = m.team1_id
    join public.teams t2 on t2.id = m.team2_id
    left join waiting w on w.match_id = m.id
    left join ready rd on rd.match_id = m.id
  )
  select (row_number() over (
            order by r.reason is not null, r.ahead_weight desc nulls last, r.ahead_since, r.rank
          ))::int,
         r.id, r.event_id, r.name, r.label, r.t1, r.t1_name, r.t2, r.t2_name,
         r.reason, r.overdue, r.waiting_since, r.court_names, r.championship, r.waiting_for_court, r.wait_until,
         r.stage, r.round_key
  from rows r
  order by 1;
end $$;

-- As before (championship_courts), hidden when cancelled.
create or replace function public.championship_holds(p_tournament uuid)
returns table (court_id uuid, court_name text, match_id uuid, event_name text, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status not in ('draft', 'cancelled') or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  return query
  select h.court_id, c.name, h.match_id, e.name, m.label
  from private.championship_holds(p_tournament, private.clock(), private.free_courts(p_tournament)) h
  join public.courts c on c.id = h.court_id
  join public.matches m on m.id = h.match_id
  join public.events e on e.id = m.event_id;
end $$;

-- As before (abandoned_basic_cleanup), keeping cancelled Basic tournaments: they're archived.
create or replace function private.clean_up_demo_tournaments() returns int
language plpgsql set search_path = '' as $$
declare
  v_deleted int;
  v_abandoned int;
begin
  delete from public.tournaments where is_demo and created_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;

  delete from public.tournaments t
  where t.simple and not t.is_demo and t.status not in ('complete', 'cancelled')
    and (select min(e.started_at) from public.events e where e.tournament_id = t.id) < now() - interval '14 days'
    and not (
      exists (select 1 from public.matches m where m.tournament_id = t.id and m.status = 'completed')
      and not exists (select 1 from public.matches m where m.tournament_id = t.id
                      and m.status in ('waiting', 'queued', 'assigned', 'in_progress'))
    );
  get diagnostics v_abandoned = row_count;

  delete from public.players p
  where p.user_id is null and p.email like '%@players.test'
    and not exists (select 1 from public.team_players tp where tp.player_id = p.id)
    and not exists (select 1 from public.registrations r where r.player_id = p.id);
  return v_deleted + v_abandoned;
end $$;

revoke execute on function public.cancel_tournament(uuid, text), public.delete_tournament(uuid),
  public.tournament_removal(uuid), public.refunds_due(uuid) from public, anon;
grant execute on function public.cancel_tournament(uuid, text), public.delete_tournament(uuid),
  public.tournament_removal(uuid), public.refunds_due(uuid) to authenticated;
