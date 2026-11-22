const beijingCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function beijingParts(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return Object.fromEntries(
    beijingCalendar.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

export function beijingDate(value: string) {
  const parts = beijingParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : '—';
}

export function formatBeijingTime(value: string, detail = false) {
  const parts = beijingParts(value);
  if (!parts) return '—';
  const clock = `${parts.hour}:${parts.minute}`;
  return detail
    ? `${parts.year}-${parts.month}-${parts.day} ${clock}:${parts.second} UTC+08:00`
    : `${parts.month}-${parts.day} ${clock}`;
}

export function BeijingTime({
  value,
  detail = false,
}: {
  value: string;
  detail?: boolean;
}) {
  const full = formatBeijingTime(value, true);
  if (full === '—') return <>{full}</>;
  return (
    <time className="beijing-time" dateTime={value} title={full}>
      {detail ? full : formatBeijingTime(value)}
    </time>
  );
}
