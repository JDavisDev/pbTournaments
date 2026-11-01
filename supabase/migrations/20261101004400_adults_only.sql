-- Players must be 18 or older, for now. Registering and sign-up say so, and a
-- birth date that says otherwise is refused. Birth dates are optional, so
-- without one this rests on the player's own agreement. Players a director adds
-- by hand and practice tournaments' made-up teams don't pass through here.
create function private.require_adult(p_birth_date date) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_birth_date is not null and p_birth_date > (private.clock()::date - interval '18 years')::date then
    raise exception 'Players must be 18 or older.' using errcode = '22023';
  end if;
end $$;

create function private.registrations_adult() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.require_adult((select birth_date from public.players where id = new.player_id));
  return new;
end $$;
create trigger registrations_adult
before insert on public.registrations
for each row execute function private.registrations_adult();

-- An account's own profile.
create function private.players_adult() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.require_adult(new.birth_date);
  return new;
end $$;
create trigger players_adult
before insert or update of birth_date on public.players
for each row when (new.user_id is not null)
execute function private.players_adult();
