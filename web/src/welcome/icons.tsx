/**
 * Inline icon set for the welcome screen.
 *
 * Deliberately dependency free (same approach as the shell's icons) so the
 * landing screen stays self contained. All icons are 24×24, stroke based and
 * inherit `currentColor`.
 */

import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function makeIcon(children: ReactNode) {
  return function Icon({ size = 18, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {children}
      </svg>
    );
  };
}

/** Folder with an open flap — primary "open" action. */
export const IconFolderOpen = makeIcon(
  <>
    <path d="M3 9.6V6.5A1.5 1.5 0 0 1 4.5 5h3l1.7 2h6.8A1.5 1.5 0 0 1 17.5 8.5v1.1" />
    <path d="M3.2 9.6h15.9a1.3 1.3 0 0 1 1.3 1.6l-1.2 4.9a1.6 1.6 0 0 1-1.6 1.2H5.1a1.6 1.6 0 0 1-1.6-1.2L2 11.2a1.3 1.3 0 0 1 1.2-1.6Z" />
  </>,
);

/** Folder with a plus — "new vault". */
export const IconFolderPlus = makeIcon(
  <>
    <path d="M3 9V6.5A1.5 1.5 0 0 1 4.5 5h3l1.7 2h6.8A1.5 1.5 0 0 1 17.5 8.5V10" />
    <path d="M3 10.2h12.5a1.5 1.5 0 0 1 1.5 1.5v6.8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 18.5Z" />
    <path d="M9.2 12.6v5.2M6.6 15.2h5.2" />
  </>,
);

/** Sparkle cluster — sample vault. */
export const IconSparkles = makeIcon(
  <>
    <path d="M11.5 4.2l1.5 3.7 3.7 1.5-3.7 1.5-1.5 3.7-1.5-3.7L6.3 9.4l3.7-1.5Z" />
    <path d="M17.8 14.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z" />
    <path d="M5.4 14.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z" />
  </>,
);

/** Archive box — a vault (a folder full of notes). */
export const IconVault = makeIcon(
  <>
    <path d="M4.6 4.8h14.8v3.6H4.6Z" />
    <path d="M3.6 8.4h16.8v9.4a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8Z" />
    <path d="M9.8 12.4h4.4" />
  </>,
);

/** Missing folder — vault row that no longer exists. */
export const IconFolderMissing = makeIcon(
  <>
    <path d="M3 9V6.5A1.5 1.5 0 0 1 4.5 5h3l1.7 2h6.8A1.5 1.5 0 0 1 17.5 8.5V10" />
    <path d="M3 10.2h12.5a1.5 1.5 0 0 1 1.5 1.5v6.8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 18.5Z" />
    <path d="M9.6 12.8l4 3.2" opacity={0.85} />
  </>,
);

export const IconClose = makeIcon(<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />);

export const IconHome = makeIcon(
  <>
    <path d="M3.8 10.4 12 4l8.2 6.4" />
    <path d="M5.8 9.4v9.2a1 1 0 0 0 1 1h3.1v-4.6h4.2v4.6h3.1a1 1 0 0 0 1-1V9.4" />
  </>,
);

export const IconAlert = makeIcon(
  <>
    <path d="M12 4.4 20.6 19.6H3.4Z" />
    <path d="M12 10v4.2" />
    <path d="M12 17.2v.01" />
  </>,
);

export const IconEnter = makeIcon(
  <>
    <path d="M18.5 5.5v7.2a2.3 2.3 0 0 1-2.3 2.3H6.2" />
    <path d="M9.6 11.6 6 15.2l3.6 3.6" />
  </>,
);

export const IconArrowRight = makeIcon(
  <>
    <path d="M4.5 12h14" />
    <path d="M13.2 6.6 18.6 12l-5.4 5.4" />
  </>,
);
