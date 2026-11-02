import { BRAND } from '@/lib/brand';
import type { PushMessage } from './push';

export const testAlert: PushMessage = {
  title: BRAND.name,
  body: 'Match alerts are on. When your match is called, you’ll get one like this: tap it to see your court.',
  url: '/profile',
  tag: 'test',
};
