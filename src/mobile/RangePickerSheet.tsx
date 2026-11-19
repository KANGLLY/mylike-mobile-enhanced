import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ActionSheet } from './ActionSheet';
import { useMobile } from './context';
import type { HomePlaybackRanges, Source } from './model';
import {
  allAvailableTokens,
  compactRangeSelection,
  expandRangeSelection,
  formatRangeSummary,
  monthToken,
  recentMonthTokens,
  sourceLabel,
  type AvailableDates,
} from './range-helpers';
import { Button, ui } from './ui';

const CHANNELS: readonly Source[] = ['all', 'likes', 'favorites'];

export function RangePickerSheet({
  visible,
  initialSource,
  onClose,
}: {
  visible: boolean;
  initialSource: Source;
  onClose: () => void;
}) {
  const { store, preferences, setPreferences } = useMobile();
  const { height: windowHeight } = useWindowDimensions();
  const [channel, setChannel] = useState<Source>(initialSource);
  const [dates, setDates] = useState<AvailableDates | null>(null);
  const [loadingDates, setLoadingDates] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expandedYears, setExpandedYears] = useState<Record<number, boolean>>({});
  const [matchCount, setMatchCount] = useState<number | null>(null);

  useEffect(() => {
    if (visible) setChannel(initialSource);
  }, [visible, initialSource]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoadingDates(true);
    setDates(null);
    setMatchCount(null);
    void store.dates({ source: channel }).then((res) => {
      if (!alive) return;
      const normalized: AvailableDates = {
        years: [...res.years]
          .sort((a, b) => b.year - a.year)
          .map((row) => ({ year: row.year, months: [...row.months].sort((a, b) => a - b) })),
        unknown: res.unknown,
      };
      setDates(normalized);
      const saved = preferences.homeRanges[channel];
      const expandedSet = expandRangeSelection(normalized, saved);
      setSelected(expandedSet);
      const initialExpand: Record<number, boolean> = {};
      normalized.years.forEach((row, index) => {
        const yearTokens = row.months.map((m) => monthToken(row.year, m));
        const checkedInYear = yearTokens.filter((t) => expandedSet.has(t)).length;
        // Expand partial years or the newest 2 years by default so months are easy to pick.
        if (index < 2 || (checkedInYear > 0 && checkedInYear < yearTokens.length)) {
          initialExpand[row.year] = true;
        }
      });
      setExpandedYears(initialExpand);
    }).catch(() => {
      if (alive) setDates({ years: [], unknown: false });
    }).finally(() => {
      if (alive) setLoadingDates(false);
    });
    return () => { alive = false; };
  }, [visible, channel, store, preferences.homeRanges]);

  const allTokens = useMemo(() => (dates ? allAvailableTokens(dates) : []), [dates]);
  const compacted = useMemo(
    () => (dates ? compactRangeSelection(dates, selected) : undefined),
    [dates, selected],
  );

  useEffect(() => {
    if (!visible || !dates) return;
    if (selected.size === 0) {
      setMatchCount(0);
      return;
    }
    let alive = true;
    void store.queueIds(compacted ? { source: channel, periods: compacted } : { source: channel })
      .then((ids) => { if (alive) setMatchCount(ids.length); })
      .catch(() => { if (alive) setMatchCount(null); });
    return () => { alive = false; };
  }, [visible, dates, channel, selected, compacted, store]);

  const toggleYear = (year: number, months: number[]) => {
    const yearTokens = months.map((m) => monthToken(year, m));
    setSelected((prev) => {
      const next = new Set(prev);
      const allYearSelected = yearTokens.every((t) => next.has(t));
      for (const t of yearTokens) {
        if (allYearSelected) next.delete(t);
        else next.add(t);
      }
      return next;
    });
  };

  const toggleToken = (token: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  const applySelection = async () => {
    if (!dates || selected.size === 0) return;
    const nextRanges: HomePlaybackRanges = { ...preferences.homeRanges };
    if (!compacted || compacted.length === 0) {
      delete nextRanges[channel];
    } else {
      nextRanges[channel] = compacted;
    }
    await setPreferences({ homeRanges: nextRanges });
    onClose();
  };

  const listMaxHeight = Math.max(220, Math.round(windowHeight * 0.44));

  return (
    <ActionSheet visible={visible} title="轮播日期范围" onClose={onClose}>
      <Text style={ui.muted}>
        分别为「推荐 / 喜欢 / 收藏」勾选要参与轮播的年份和月份；取消勾选早期月份即可跳过不想再看的内容。
      </Text>

      <View style={styles.channelRow}>
        {CHANNELS.map((item) => {
          const active = item === channel;
          const hasCustom = Boolean(preferences.homeRanges[item]?.length);
          return (
            <Pressable
              key={item}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setChannel(item)}
              style={[styles.channelTab, active && styles.channelTabActive]}
            >
              <Text style={[styles.channelText, active && styles.channelTextActive]}>
                {sourceLabel(item)}
              </Text>
              {hasCustom && <View style={styles.channelDot} />}
            </Pressable>
          );
        })}
      </View>

      {dates && allTokens.length > 0 && (
        <View style={styles.shortcuts}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(new Set(allTokens))}
            style={[styles.chip, compacted === undefined && styles.chipActive]}
          >
            <Text style={[styles.chipText, compacted === undefined && styles.chipTextActive]}>全选（不限）</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(new Set(recentMonthTokens(dates, 6)))}
            style={styles.chip}
          >
            <Text style={styles.chipText}>近半年</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(new Set(recentMonthTokens(dates, 12)))}
            style={styles.chip}
          >
            <Text style={styles.chipText}>近一年</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(new Set())}
            style={styles.chip}
          >
            <Text style={styles.chipText}>全不选</Text>
          </Pressable>
        </View>
      )}

      {loadingDates ? (
        <ActivityIndicator color="#fff" style={{ paddingVertical: 30 }} />
      ) : !dates || allTokens.length === 0 ? (
        <Text style={ui.muted}>当前「{sourceLabel(channel)}」频道暂无可用作品。</Text>
      ) : (
        <ScrollView style={{ maxHeight: listMaxHeight }} showsVerticalScrollIndicator>
          <View style={styles.yearList}>
            {dates.years.map((row) => {
              const yearTokens = row.months.map((m) => monthToken(row.year, m));
              const checkedCount = yearTokens.filter((t) => selected.has(t)).length;
              const allChecked = checkedCount === yearTokens.length && yearTokens.length > 0;
              const partial = checkedCount > 0 && checkedCount < yearTokens.length;
              const expanded = Boolean(expandedYears[row.year]);
              return (
                <View key={row.year} style={styles.yearCard}>
                  <View style={styles.yearHeader}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: allChecked }}
                      onPress={() => toggleYear(row.year, row.months)}
                      hitSlop={8}
                      style={styles.checkArea}
                    >
                      <Ionicons
                        name={allChecked ? 'checkbox' : partial ? 'remove-circle' : 'square-outline'}
                        size={22}
                        color={allChecked || partial ? '#fc2f56' : '#8b909d'}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setExpandedYears((prev) => ({ ...prev, [row.year]: !expanded }))}
                      style={styles.yearLabelBtn}
                    >
                      <Text style={styles.yearTitle}>{row.year} 年</Text>
                      <Text style={styles.yearMeta}>
                        {allChecked ? `全选（${row.months.length} 个月）` : checkedCount > 0 ? `已选 ${checkedCount}/${row.months.length} 个月` : '未勾选'}
                      </Text>
                      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={17} color="#8b909d" />
                    </Pressable>
                  </View>
                  {expanded && (
                    <View style={styles.monthGrid}>
                      {row.months.map((m) => {
                        const tok = monthToken(row.year, m);
                        const on = selected.has(tok);
                        return (
                          <Pressable
                            key={tok}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: on }}
                            onPress={() => toggleToken(tok)}
                            style={[styles.monthChip, on && styles.monthChipOn]}
                          >
                            <Ionicons
                              name={on ? 'checkmark' : 'add'}
                              size={13}
                              color={on ? '#fff' : '#8b909d'}
                            />
                            <Text style={[styles.monthText, on && styles.monthTextOn]}>{m}月</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}

            {dates.unknown && (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected.has('unknown') }}
                onPress={() => toggleToken('unknown')}
                style={styles.unknownRow}
              >
                <Ionicons
                  name={selected.has('unknown') ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={selected.has('unknown') ? '#fc2f56' : '#8b909d'}
                />
                <Text style={styles.yearTitle}>发布日期未知的作品</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}

      {selected.size === 0 && dates && allTokens.length > 0 ? (
        <Text style={styles.warn}>请至少勾选一个月份，或点「全选（不限）」</Text>
      ) : dates && allTokens.length > 0 ? (
        <Text style={ui.muted}>
          当前范围：{formatRangeSummary(compacted)}
          {matchCount !== null ? ` · 共 ${matchCount} 条作品参与轮播` : ''}
        </Text>
      ) : null}

      <View style={styles.footerBtns}>
        <View style={{ flex: 1 }}>
          <Button
            title="应用到当前频道"
            selected
            disabled={!dates || allTokens.length === 0 || selected.size === 0}
            onPress={() => { void applySelection(); }}
          />
        </View>
        <Button title="关闭" onPress={onClose} />
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  channelRow: { flexDirection: 'row', gap: 8 },
  channelTab: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#1b1d26',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  channelTabActive: { backgroundColor: '#fc2f56' },
  channelText: { color: '#9ea3b0', fontSize: 13.5, fontWeight: '600' },
  channelTextActive: { color: '#ffffff' },
  channelDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#ffd25e' },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: '#1b1d26' },
  chipActive: { backgroundColor: '#fc2f5633', borderWidth: 1, borderColor: '#fc2f56' },
  chipText: { color: '#c4c7d0', fontSize: 12 },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  yearList: { gap: 10, paddingBottom: 4 },
  yearCard: { borderRadius: 12, backgroundColor: '#1b1d26', overflow: 'hidden' },
  yearHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 46 },
  checkArea: { paddingRight: 10, paddingVertical: 6 },
  yearLabelBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  yearTitle: { color: '#f2f3f7', fontSize: 14.5, fontWeight: '600' },
  yearMeta: { flex: 1, color: '#8b909d', fontSize: 12 },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ffffff10',
  },
  monthChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#2a2d3a',
  },
  monthChipOn: { backgroundColor: '#fc2f56' },
  monthText: { color: '#b4b8c4', fontSize: 12.5 },
  monthTextOn: { color: '#ffffff', fontWeight: '600' },
  unknownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#1b1d26',
  },
  warn: { color: '#ff8a9f', fontSize: 12.5 },
  footerBtns: { flexDirection: 'row', gap: 10 },
});
