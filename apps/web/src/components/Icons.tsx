import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = (props: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
});

export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.5 10.5 12 4l8.5 6.5V20a1 1 0 0 1-1 1h-4v-6h-7v6h-4a1 1 0 0 1-1-1z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconLive = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4" width="19" height="14" rx="3" />
    <path d="M8 21h8" />
    <circle cx="12" cy="11" r="2.4" fill="currentColor" stroke="none" />
    <path d="M6.6 7.6a7 7 0 0 0 0 6.8M17.4 7.6a7 7 0 0 1 0 6.8" />
  </svg>
);

export const IconBookmark = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.8h12v17l-6-4.4-6 4.4z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconBookmarkOutline = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.8h12v17l-6-4.4-6 4.4z" />
  </svg>
);

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5" />
    <path d="M4 20h16" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const IconShare = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12M8 6.5 12 2.5l4 4" />
    <path d="M5 13v6.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V13" />
  </svg>
);

export const IconHeartFilled = (p: P) => (
  <svg {...base(p)}>
    <path
      d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20Z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

export const IconBookmarkFilled = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.8h12v17l-6-4.4-6 4.4z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconQueue = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h10M4 12h10M4 17h6" />
    <circle cx="18" cy="17" r="2.6" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
  </svg>
);

export const IconReply = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12.5c0 4-3.6 6.5-8 6.5a10 10 0 0 1-2.6-.34L4.5 21l1.1-3.6A6.7 6.7 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z" />
  </svg>
);

export const IconRepost = (p: P) => (
  <svg {...base(p)}>
    <path d="M6.5 8h9a3 3 0 0 1 3 3v3" />
    <path d="m9 5-2.5 3L9 11" />
    <path d="M17.5 16h-9a3 3 0 0 1-3-3v-3" />
    <path d="m15 19 2.5-3L15 13" />
  </svg>
);

export const IconHeart = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20Z" />
  </svg>
);

export const IconChart = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 19V9M10 19V5M15 19v-7M20 19v-4" />
  </svg>
);

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 13 4.5 4.5L19 7" />
  </svg>
);

export const IconSpinner = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
  </svg>
);

export const IconPlay = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 5.5 19 12 8 18.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconWifiOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18" />
    <path d="M8.5 12.6a5.5 5.5 0 0 1 7 0M5.5 9.2A10.5 10.5 0 0 1 12 7c1.7 0 3.3.4 4.7 1.1" />
    <circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 18h10.5a3 3 0 0 0 .3-6 5 5 0 0 0-9.4-1.4A3.5 3.5 0 0 0 7 18Z" />
    <path d="M12 10v6m0 0-2.2-2.2M12 16l2.2-2.2" />
  </svg>
);

export const IconArrowDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v14m0 0 5-5m-5 5-5-5" />
  </svg>
);

export const IconChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="m9.5 5 7 7-7 7" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4h-4" />
  </svg>
);

export const IconBook = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
    <path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
);

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4.5h3.3l4 5.4 4.3-5.4H19l-6 7.5 6.4 8h-3.3l-4.2-5.6-4.5 5.6H5.1l6.2-7.7z" fill="currentColor" stroke="none" />
  </svg>
);
