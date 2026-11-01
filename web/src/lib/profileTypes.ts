import type { PlayerFacts } from './eligibility';

/** Who a player is, as forms hold it: blank fields are ''. */
export interface PlayerProfile extends PlayerFacts {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  sms_opt_in: boolean;
}
