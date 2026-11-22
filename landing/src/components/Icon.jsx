// Lucide icon paths, copied locally per design-system spec (2px stroke, round caps).
const PATHS = {
  'shield-check': [
    ['path', 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
    ['path', 'm9 12 2 2 4-4'],
  ],
  users: [
    ['path', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'],
    ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', 'M22 21v-2a4 4 0 0 0-3-3.87'],
    ['path', 'M16 3.13a4 4 0 0 1 0 7.75'],
  ],
  bell: [
    ['path', 'M10.268 21a2 2 0 0 0 3.464 0'],
    ['path', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'],
  ],
  star: [
    ['path', 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z'],
  ],
  'scan-line': [
    ['path', 'M3 7V5a2 2 0 0 1 2-2h2'],
    ['path', 'M17 3h2a2 2 0 0 1 2 2v2'],
    ['path', 'M21 17v2a2 2 0 0 1-2 2h-2'],
    ['path', 'M7 21H5a2 2 0 0 1-2-2v-2'],
    ['path', 'M7 12h10'],
  ],
  'trending-up': [
    ['path', 'M16 7h6v6'],
    ['path', 'm22 7-8.5 8.5-5-5L2 17'],
  ],
  'arrow-up-right': [
    ['path', 'M7 7h10v10'],
    ['path', 'M7 17 17 7'],
  ],
  'message-circle': [
    ['path', 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 8 }],
    ['path', 'm21 21-4.3-4.3'],
  ],
  house: [
    ['path', 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8'],
    ['path', 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  ],
  layers: [
    ['path', 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z'],
    ['path', 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65'],
    ['path', 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],
  ],
  x: [
    ['path', 'M18 6 6 18'],
    ['path', 'm6 6 12 12'],
  ],
  package: [
    ['path', 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z'],
    ['path', 'M12 22V12'],
    ['path', 'm3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7'],
  ],
  user: [
    ['path', 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'],
    ['circle', { cx: 12, cy: 7, r: 4 }],
  ],
  heart: [
    ['path', 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'],
  ],
  plus: [
    ['path', 'M5 12h14'],
    ['path', 'M12 5v14'],
  ],
  instagram: [
    ['path', 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z'],
    ['circle', { cx: 12, cy: 12, r: 4 }],
    // the flash dot — a zero-length stroke, drawn as a disc by the round cap
    ['path', 'M17.5 6.5h.01'],
  ],
}

export default function Icon({ name, size = 20, color = 'currentColor', strokeWidth = 2, ...rest }) {
  const shapes = PATHS[name]
  if (!shapes) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {shapes.map(([tag, d], i) =>
        tag === 'circle' ? <circle key={i} {...d} /> : <path key={i} d={d} />
      )}
    </svg>
  )
}
