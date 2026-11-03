import type { PlayerFacts } from './eligibility';

/** Who a player is, as forms hold it: blank fields are ''. */
export interface PlayerProfile extends PlayerFacts {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  sms_opt_in: boolean;
}

/** A profile from the database (get_my_profile, save_my_profile): blank fields as '', the way forms hold them. */
export function mapProfile(row: Record<string, unknown> | null): PlayerProfile | null {
  if (!row) return null;
  const text = (key: string) => (row[key] == null ? '' : String(row[key]));
  return {
    first_name: text('first_name'),
    last_name: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    sms_opt_in: row.sms_opt_in === true,
    gender: text('gender') as PlayerProfile['gender'],
    birth_date: text('birth_date'),
    dupr_id: text('dupr_id'),
    dupr_doubles: text('dupr_doubles'),
    dupr_singles: text('dupr_singles'),
    self_rating: text('self_rating'),
  };
}
