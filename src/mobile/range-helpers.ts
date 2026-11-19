import type { Source } from './model.ts';

export type YearMonths = { year: number; months: number[] };
export type AvailableDates = { years: YearMonths[]; unknown: boolean };

export function monthToken(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function allAvailableTokens(available: AvailableDates): string[] {
  const tokens: string[] = [];
  for (const row of available.years) {
    const months = [...row.months].sort((a, b) => b - a);
    for (const m of months) tokens.push(monthToken(row.year, m));
  }
  if (available.unknown) tokens.push('unknown');
  return tokens;
}

export function expandRangeSelection(available: AvailableDates, saved?: readonly string[]): Set<string> {
  const all = allAvailableTokens(available);
  if (!saved || saved.length === 0) return new Set(all);
  const yearMap = new Map(available.years.map((row) => [String(row.year), row.months]));
  const validSet = new Set(all);
  const out = new Set<string>();
  for (const token of saved) {
    if (validSet.has(token)) {
      out.add(token);
      continue;
    }
    const months = yearMap.get(token);
    if (months) {
      for (const m of months) out.add(monthToken(Number(token), m));
    }
  }
  return out;
}

export function compactRangeSelection(available: AvailableDates, selected: ReadonlySet<string>): string[] | undefined {
  const all = allAvailableTokens(available);
  if (all.length === 0) return undefined;
  const selectedAll = all.every((token) => selected.has(token));
  if (selectedAll) return undefined;
  const result: string[] = [];
  for (const row of available.years) {
    const yearTokens = row.months.map((m) => monthToken(row.year, m));
    if (yearTokens.length > 0 && yearTokens.every((t) => selected.has(t))) {
      result.push(String(row.year));
    } else {
      for (const m of [...row.months].sort((a, b) => b - a)) {
        const t = monthToken(row.year, m);
        if (selected.has(t)) result.push(t);
      }
    }
  }
  if (available.unknown && selected.has('unknown')) result.push('unknown');
  return result;
}

export function recentMonthTokens(available: AvailableDates, count: number): string[] {
  const sorted: string[] = [];
  for (const row of [...available.years].sort((a, b) => b.year - a.year)) {
    for (const m of [...row.months].sort((a, b) => b - a)) {
      sorted.push(monthToken(row.year, m));
    }
  }
  return sorted.slice(0, Math.max(0, count));
}

export function formatRangeSummary(tokens?: readonly string[]): string {
  if (!tokens || tokens.length === 0) return '全部日期';
  if (tokens.length === 1) {
    const only = tokens[0];
    if (only === 'unknown') return '日期未知';
    return only.length === 4 ? `${only}年` : only.replace('-', '.');
  }
  return `已选 ${tokens.length} 项`;
}

export function sourceLabel(source: Source): string {
  return source === 'all' ? '推荐' : source === 'likes' ? '喜欢' : '收藏';
}
