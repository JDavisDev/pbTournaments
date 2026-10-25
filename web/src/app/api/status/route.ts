import { paymentsMode } from '@/server/payments';
import { emailMode, textsMode } from '@/server/texts';

/** Which payment and messaging modes the server is in, for the screens to show. */
export async function POST() {
  return Response.json({ payments: paymentsMode(), texts: textsMode(), email: emailMode() });
}
