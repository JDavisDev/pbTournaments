// The Courtside Tournaments logo: the mark (a slash between two balls), the
// name in Saira Black Italic at its widest, and TOURNAMENTS in Montserrat.
// Drawn as SVG so each lockup scales as one piece; textLength keeps the words
// their designed width even before the fonts load. Colored by text-logo.
import { BRAND } from '@/lib/brand';

const name = BRAND.name.toUpperCase();
const descriptor = BRAND.descriptor.toUpperCase();
const label = `${BRAND.name} ${BRAND.descriptor}`;

const nameStyle = { fontFamily: 'var(--font-saira)', fontStyle: 'italic', fontWeight: 900, fontStretch: '125%' } as const;
const descriptorStyle = { fontFamily: 'var(--font-montserrat)', fontWeight: 500 } as const;

/** The mark alone, 192 × 120. */
function MarkShapes() {
  return (
    <>
      <circle cx="21" cy="65" r="21" />
      <polygon points="90,0 148,0 101,120 43,120" />
      <circle cx="171" cy="65" r="21" />
    </>
  );
}

export function LogoMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 192 120" fill="currentColor" className={`text-logo ${className}`} aria-hidden>
      <MarkShapes />
    </svg>
  );
}

/** Mark over the name over TOURNAMENTS, for the home page. */
export function LogoStacked({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 664 268" fill="currentColor" role="img" aria-label={label} className={`text-logo ${className}`}>
      <g transform="translate(228 0)">
        <MarkShapes />
      </g>
      <text x="0" y="213" fontSize="101" textLength="664" lengthAdjust="spacingAndGlyphs" style={nameStyle}>
        {name}
      </text>
      <text x="87" y="267" fontSize="40" textLength="497" lengthAdjust="spacing" style={descriptorStyle}>
        {descriptor}
      </text>
    </svg>
  );
}

/** Mark | name over TOURNAMENTS, for the header. */
export function LogoHorizontal({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 392 60" fill="currentColor" role="img" aria-label={label} className={`text-logo ${className}`}>
      <g transform="translate(0 4) scale(0.43)">
        <MarkShapes />
      </g>
      <rect x="106.5" y="1" width="1.5" height="52" />
      <text x="130" y="32" fontSize="41" textLength="262" lengthAdjust="spacingAndGlyphs" style={nameStyle}>
        {name}
      </text>
      <text x="141" y="60" fontSize="20" textLength="236" lengthAdjust="spacing" style={descriptorStyle}>
        {descriptor}
      </text>
    </svg>
  );
}
