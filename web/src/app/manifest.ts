import type { MetadataRoute } from 'next';
import { BRAND } from '@/lib/brand';

// What a phone uses when the site is added to its Home Screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.name} ${BRAND.descriptor}`,
    short_name: BRAND.name,
    description: 'Your court, your matches and score reporting on tournament day.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0f2a20',
    theme_color: '#0f2a20',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
