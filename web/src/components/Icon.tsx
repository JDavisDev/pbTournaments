// A small set of line icons, drawn for this app (no emoji: they render
// differently on every phone and read poorly at large text sizes).
import type { SVGProps } from 'react';

const paths = {
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  check: 'M4.5 12.5l5 5 10-11',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  top: 'M5 4h14M12 20V9M6 14l6-6 6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  whistle: 'M4 12a5 5 0 1 0 10 0 5 5 0 0 0-10 0zM9 7h12v4h-7',
  text: 'M4 7V5h10v2M9 5v14M7 19h4M14 12v-1h6v1M17 11v8M15.5 19h3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  chevron: 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  megaphone: 'M4 10v4h3l7 4V6l-7 4zM17 9.5a3.5 3.5 0 0 1 0 5M7 14l1.5 5h2.5l-1-4.5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  message: 'M4 5h16v11H9l-5 4z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  home: 'M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3M12 16.5v.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  money: 'M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3S7.5 5.8 7.5 7.5s2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3',
  upload: 'M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  tv: 'M3 6h18v12H3zM8 21h8',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6 6 0 0 1 3 5.5',
  pen: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = 'h-5 w-5', ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const filled = name === 'play';
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`shrink-0 ${className}`}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.5 : 2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
