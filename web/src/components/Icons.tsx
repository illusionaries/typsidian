/**
 * Small stroke icon set (16x16, currentColor) — no icon dependency.
 */

import type { JSX, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function makeIcon(paths: JSX.Element, viewBox = '0 0 16 16') {
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const IconSplit = makeIcon(
  <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" />
    <path d="M8 2.5v11" />
  </>,
);

export const IconVisual = makeIcon(
  <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" />
    <path d="M4.6 6h4M4.6 8.5h6M4.6 11h3" />
  </>,
);

export const IconEye = makeIcon(
  <>
    <path d="M1.7 8s2.4-4.2 6.3-4.2S14.3 8 14.3 8s-2.4 4.2-6.3 4.2S1.7 8 1.7 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </>,
);

export const IconSidebar = makeIcon(
  <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" />
    <path d="M6 2.5v11" />
  </>,
);

export const IconRefresh = makeIcon(
  <>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
    <path d="M13.4 2.6v3h-3" />
  </>,
);

export const IconDownload = makeIcon(
  <>
    <path d="M8 2.4v7.2" />
    <path d="M5.2 7l2.8 2.8L10.8 7" />
    <path d="M2.6 12.4h10.8" />
  </>,
);

export const IconSun = makeIcon(
  <>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
  </>,
);

export const IconMoon = makeIcon(
  <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />,
);

export const IconPlus = makeIcon(<path d="M8 3.2v9.6M3.2 8h9.6" />);

export const IconClose = makeIcon(<path d="M4 4l8 8M12 4l-8 8" />);

export const IconWarning = makeIcon(
  <>
    <path d="M8 2.2 14.4 13H1.6L8 2.2Z" />
    <path d="M8 6v3.2M8 11.2v.1" />
  </>,
);

export const IconError = makeIcon(
  <>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 5v3.6M8 10.8v.1" />
  </>,
);

export const IconCheck = makeIcon(<path d="M3.4 8.4 6.6 11.6 12.8 4.6" />);

export const IconBold = makeIcon(
  <>
    <path d="M5 3.2h3.6a2.4 2.4 0 0 1 0 4.8H5z" />
    <path d="M5 8h4.1a2.4 2.4 0 0 1 0 4.8H5z" />
  </>,
);

export const IconItalic = makeIcon(<path d="M9.6 3.2H6.4M9.6 12.8H6.4M9.2 3.2 6.8 12.8" />);

export const IconCode = makeIcon(<path d="M5.6 4.8 2.4 8l3.2 3.2M10.4 4.8 13.6 8l-3.2 3.2" />);

export const IconHeading = makeIcon(<path d="M3.4 3.4v9.2M12.6 3.4v9.2M3.4 8h9.2" />);

export const IconList = makeIcon(
  <>
    <path d="M5.8 4.6h8M5.8 8h8M5.8 11.4h8" />
    <path d="M2.6 4.6v.1M2.6 8v.1M2.6 11.4v.1" />
  </>,
);

export const IconQuote = makeIcon(
  <>
    <path d="M2.8 3.6v8.8" />
    <path d="M6 5h7M6 8h7M6 11h4.6" />
  </>,
);

export const IconMath = makeIcon(
  <>
    <path d="M3 4.4h4.4M5.2 4.4v7.2" />
    <path d="M10 6.4l3.2 3.2M13.2 6.4 10 9.6" />
  </>,
);

export const IconSparkles = makeIcon(
  <>
    <path d="M8 2.2l1.2 3.2 3.2 1.2-3.2 1.2L8 11l-1.2-3.2L3.6 6.6l3.2-1.2z" />
    <path d="M12.4 10.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" />
  </>,
);

export const IconChevron = makeIcon(<path d="M6 4l4 4-4 4" />);

export const IconFile = makeIcon(
  <>
    <path d="M3.6 2.4h5.2l3.6 3.6v7.6H3.6z" />
    <path d="M8.8 2.4V6h3.6" />
  </>,
);

export const IconFolder = makeIcon(
  <path d="M2.2 4.4h4l1.2 1.6h6.4v6.4a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z" />,
);

export const IconSearch = makeIcon(
  <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.6 13.6" />
  </>,
);

export const IconMore = makeIcon(
  <>
    <circle cx="3.4" cy="8" r=".9" />
    <circle cx="8" cy="8" r=".9" />
    <circle cx="12.6" cy="8" r=".9" />
  </>,
);

export const IconZoomIn = makeIcon(
  <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.6 13.6M5.2 7h3.6M7 5.2v3.6" />
  </>,
);

export const IconZoomOut = makeIcon(
  <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.6 13.6M5.2 7h3.6" />
  </>,
);

export const IconFit = makeIcon(
  <>
    <path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10" />
  </>,
);

export const IconClose2 = IconClose;
