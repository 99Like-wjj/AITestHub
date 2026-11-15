export type UsageHeatmapScope = 'personal' | 'platform';
type UsageHeatmapLevel = 0 | 1 | 2 | 3 | 4;

const upperBounds: Record<
  UsageHeatmapScope,
  readonly [bigint, bigint, bigint]
> = {
  platform: [50_000_000n, 300_000_000n, 1_000_000_000n],
  personal: [10_000_000n, 60_000_000n, 200_000_000n],
};

export function usageHeatmapLevel(
  tokens: string | null,
  scope: UsageHeatmapScope,
): UsageHeatmapLevel {
  const value = tokens === null ? null : BigInt(tokens);
  if (value === null || value === 0n) return 0;
  const [first, second, third] = upperBounds[scope];
  if (value <= first) return 1;
  if (value <= second) return 2;
  if (value <= third) return 3;
  return 4;
}

export function usageHeatmapLegend(
  scope: UsageHeatmapScope,
): readonly { level: UsageHeatmapLevel; label: string }[] {
  const [first, second, third] = upperBounds[scope];
  const format = (value: bigint) => value.toLocaleString('zh-CN');
  return [
    { level: 0, label: '1级：0 Token' },
    { level: 1, label: `2级：1–${format(first)} Token` },
    {
      level: 2,
      label: `3级：${format(first + 1n)}–${format(second)} Token`,
    },
    {
      level: 3,
      label: `4级：${format(second + 1n)}–${format(third)} Token`,
    },
    { level: 4, label: `5级：超过 ${format(third)} Token` },
  ];
}
