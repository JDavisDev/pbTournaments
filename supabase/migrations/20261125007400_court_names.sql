-- Court names: a tournament that only has courts 7-11 can call them that.
--
-- set_courts saves Setup's court list in one go: how many courts, their names
-- and their order. Names can be swapped ("Court 1" <-> "Court 2") because every
-- court is renamed at once. set_court_count (the court desk's + and -) now
-- names a new court after the highest-numbered one, so courts 7-11 get
-- "Court 12", not "Court 6".

-- p_courts: the courts top to bottom, [{"id": uuid or null, "name": text}].
-- An id renames that court; no id adds one (bringing back a removed court of
-- that name, so its match history stays with it). Courts left out are removed
-- as set_court_count removes them: their live matches go back to the queue,
-- and courts with match history are kept (retired). Returns the court count.
create function public.set_courts(p_tournament uuid, p_courts jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_name text;
  v_id uuid;
  v_names text[] := '{}';
  v_ids uuid[] := '{}';
  v_court uuid;
  i int;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  if jsonb_typeof(p_courts) is distinct from 'array' or jsonb_array_length(p_courts) > 200 then
    raise exception 'Use between 0 and 200 courts' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_courts) loop
    v_name := btrim(coalesce(v_item ->> 'name', ''));
    if v_name = '' then
      raise exception 'Every court needs a name' using errcode = '22023';
    end if;
    if length(v_name) > 40 then
      raise exception 'Court names can be at most 40 characters' using errcode = '22023';
    end if;
    if lower(v_name) in (select lower(n) from unnest(v_names) n) then
      raise exception 'Two courts are both called “%”', v_name using errcode = '22023';
    end if;
    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id = any (v_ids) then
      raise exception 'A court is listed twice' using errcode = '22023';
    end if;
    if v_id is not null and not exists (
      select 1 from public.courts where id = v_id and tournament_id = p_tournament and retired_at is null
    ) then
      raise exception 'Court not found. Reload and try again.' using errcode = 'P0002';
    end if;
    v_names := v_names || v_name;
    v_ids := v_ids || v_id;
  end loop;

  -- Courts left out.
  for v_court in
    select id from public.courts
    where tournament_id = p_tournament and retired_at is null and not (id = any (array_remove(v_ids, null)))
  loop
    update public.matches
    set status = 'queued', court_id = null, assigned_at = null, started_at = null
    where court_id = v_court and status in ('assigned', 'in_progress');
    if exists (select 1 from public.matches where court_id = v_court) then
      update public.courts set retired_at = private.clock() where id = v_court;
    else
      delete from public.courts where id = v_court;
    end if;
  end loop;

  -- Free every name first, so names can trade places.
  update public.courts set name = id::text where tournament_id = p_tournament and retired_at is null;

  for i in 1 .. cardinality(v_names) loop
    if v_ids[i] is not null then
      if exists (
        select 1 from public.courts
        where tournament_id = p_tournament and retired_at is not null and name = v_names[i]
      ) then
        raise exception 'A court removed during play is still called “%”, for its match history. Pick another name.', v_names[i]
          using errcode = '23505';
      end if;
      update public.courts set name = v_names[i], sort_order = i where id = v_ids[i];
    else
      select id into v_court from public.courts
      where tournament_id = p_tournament and retired_at is not null and name = v_names[i];
      if found then
        update public.courts set retired_at = null, out_of_service = false, sort_order = i where id = v_court;
      else
        insert into public.courts (tournament_id, name, sort_order) values (p_tournament, v_names[i], i);
      end if;
    end if;
  end loop;

  perform private.auto_assign(p_tournament);
  return cardinality(v_names);
end $$;

-- The number at the end of a court's name ("Court 12" -> 12), if any.
create function private.court_number(p_name text) returns int
language sql immutable set search_path = '' as $$
  select (substring(p_name from '(\d{1,6})\s*$'))::int
$$;

-- As before (20261024000200_court_engine), except a new court is named one
-- past the highest-numbered court, and goes last.
create or replace function public.set_court_count(p_tournament uuid, p_count int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_active int;
  v_court uuid;
  v_number int;
  v_sort int;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  if p_count < 0 or p_count > 200 then
    raise exception 'Court count must be between 0 and 200' using errcode = '22023';
  end if;

  select count(*) into v_active from public.courts where tournament_id = p_tournament and retired_at is null;

  while v_active < p_count loop
    select id into v_court from public.courts
    where tournament_id = p_tournament and retired_at is not null
    order by sort_order, name limit 1;
    if v_court is not null then
      update public.courts set retired_at = null, out_of_service = false where id = v_court;
    else
      select coalesce(max(private.court_number(name)), v_active) + 1, coalesce(max(sort_order), 0) + 1
      into v_number, v_sort
      from public.courts where tournament_id = p_tournament and retired_at is null;
      while exists (select 1 from public.courts where tournament_id = p_tournament and name = 'Court ' || v_number) loop
        v_number := v_number + 1;
      end loop;
      insert into public.courts (tournament_id, name, sort_order) values (p_tournament, 'Court ' || v_number, v_sort);
    end if;
    v_active := v_active + 1;
  end loop;

  while v_active > p_count loop
    select id into v_court from public.courts
    where tournament_id = p_tournament and retired_at is null
    order by sort_order desc, name desc limit 1;
    update public.matches
    set status = 'queued', court_id = null, assigned_at = null, started_at = null
    where court_id = v_court and status in ('assigned', 'in_progress');
    if exists (select 1 from public.matches where court_id = v_court) then
      update public.courts set retired_at = private.clock() where id = v_court;
    else
      delete from public.courts where id = v_court;
    end if;
    v_active := v_active - 1;
  end loop;

  perform private.auto_assign(p_tournament);
  return v_active;
end $$;
