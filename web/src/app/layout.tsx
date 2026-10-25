import type { Metadata } from 'next';
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Barlow_Condensed } from 'next/font/google';
import { BRAND } from '@/lib/brand';
import './globals.css';

// Body text: designed by the Braille Institute for low-vision readers, so
// look-alike characters (1/l/I, 0/O) stay distinct. Many of our players are 50+.
const bodyFont = Atkinson_Hyperlegible_Next({
  variable: '--font-body',
  subsets: ['latin'],
  // Next has no size metrics for these fonts; fall back to the system font.
  adjustFontFallback: false,
  fallback: ['system-ui', 'sans-serif'],
});

// DUPR IDs and codes.
const monoFont = Atkinson_Hyperlegible_Mono({
  variable: '--font-code',
  subsets: ['latin'],
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'monospace'],
});

// Headlines and scoreboards.
const barlowCondensed = Barlow_Condensed({
  variable: '--font-barlow-condensed',
  subsets: ['latin'],
  weight: ['600', '700', '800'],
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: 'Tournament registration, brackets and live court assignment.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${bodyFont.variable} ${monoFont.variable} ${barlowCondensed.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply the reader's saved text size before the page paints (see TextSizeButton). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem('courtside-text-size');if(s)document.documentElement.dataset.text=s}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
