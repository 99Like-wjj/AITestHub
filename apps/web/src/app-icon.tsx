import type { CSSProperties } from 'react';
import { SettingOutlined } from '@ant-design/icons';
// V3 SVG geometry; E013 replaces its irregular gear with the pinned Ant Design icon.
const paths = {
  spark: 'M12 3 9.7 9.7 3 12l6.7 2.3L12 21l2.3-6.7L21 12l-6.7-2.3L12 3Z',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  file: 'M14 2H5v20h14V7l-5-5Z M14 2v6h5 M8 12h8 M8 16h5',
  check: 'm8 12 3 3 5-6 M5 3h14v19H5z',
  api: 'm8 6-6 6 6 6 m8-12 6 6-6 6 m-3-15-2 18',
  calendar: 'M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h3 M14 14h2',
  play: 'M9 6v12l10-6-10-6Z M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  bug: 'M8 8h8v10a4 4 0 0 1-8 0V8Z M9 8V6a3 3 0 0 1 6 0v2 M4 11h4 M16 11h4 M3 16h5 M16 16h5 M6 21l3-3 M15 18l3 3',
  book: 'M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-4-2-7-1-10 1Z M12 5v16',
  chart: 'M4 3v18h17 M8 17v-6 M13 17V6 M18 17V9',
  panel: 'M3 3h18v18H3z M9 3v18',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  down: 'm6 9 6 6 6-6',
  send: 'M12 20V4 m-6 6 6-6 6 6',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  x: 'm6 6 12 12 M18 6 6 18',
  compose:
    'M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5 M14 4l6 6 M10 14l1-4 8-8 4 4-8 8-5 1Z',
  'folder-closed':
    'M3 7a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  'folder-open':
    'M3 17V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2 M3 20l3-9h16l-3 9H3Z',
  plus: 'M12 5v14 M5 12h14',
  user: 'M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 22v-3a8 8 0 0 1 16 0v3',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 3 7 3 7H3s3-1 3-7 M10 20h4',
} as const;
export function AppIcon({
  name,
  className,
  style,
}: {
  name: keyof typeof paths | 'more' | 'settings';
  className?: string;
  style?: CSSProperties;
}) {
  if (name === 'settings')
    return (
      <SettingOutlined
        className={`ico app-standard-icon${className ? ` ${className}` : ''}`}
        style={style}
        aria-hidden="true"
      />
    );
  return (
    <svg
      className={`ico${className ? ` ${className}` : ''}`}
      style={style}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {name === 'more' ? (
        <>
          {[5, 12, 19].map((cx) => (
            <circle
              key={cx}
              cx={cx}
              cy="12"
              r="1.5"
              fill="currentColor"
              stroke="none"
            />
          ))}
        </>
      ) : (
        <path d={paths[name]} />
      )}
    </svg>
  );
}
