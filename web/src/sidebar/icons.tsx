/**
 * Inline SVG icons for the sidebar.
 *
 * Hand-rolled so the sidebar stays dependency-free; every icon inherits the
 * current text colour and is hidden from assistive technology by default.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

export function IconPlus(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v6h-6" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4L21 21" />
    </svg>
  );
}

export function IconChevron({
  expanded = false,
  className,
  ...props
}: IconProps & { expanded?: boolean }) {
  return (
    <svg
      {...base}
      {...props}
      className={`tp-chevron${expanded ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      <path d="M9 5.5l6.5 6.5L9 18.5" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.4l2 2h5.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function IconDoc(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 3.5h6.5L18 8v12.5H7z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M9.5 12.5h6M9.5 16h4" />
    </svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 19.5l4.2-.9 9-9a2.1 2.1 0 0 0-3-3l-9 9z" />
      <path d="M13.7 5.6l4.2 4.2" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7l1 13h9l1-13" />
      <path d="M10.5 10.5v6M13.5 10.5v6" />
    </svg>
  );
}

export function IconWarning(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 4L2.8 20h18.4z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  );
}
