import Ionicons from '@expo/vector-icons/Ionicons';
import { setAppIcon, getAppIcon } from '@semisquircle/expo-dynamic-app-icon';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { pinHomeShortcut } from './home-icon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { cacheUsage, clearPlaybackCache, bytesLabel } from './cache';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import type { MobileStore } from './store';
import { PageHeader, ui } from './ui';

type Usage = { overview: Awaited<ReturnType<MobileStore['accountOverview']>>; database: number; cache: ReturnType<typeof cacheUsage> };
const ICON_OPTIONS: { name: string; label: string; color: string }[] = [
  { name: 'classic', label: '经典', color: '#2A2028' },
  { name: 'midnight', label: '午夜黑', color: '#16161a' },
  { name: 'sakura', label: '樱花粉', color: '#ff5c96' },
  { name: 'ocean', label: '深海蓝', color: '#2f6bff' },
  { name: 'forest', label: '森林绿', color: '#12a06a' },
];
const ICON_LABELS: Record<string, string> = Object.fromEntries(ICON_OPTIONS.map(option => [option.name, option.label]));
function Section({ title, children }: { title: string; children: ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.card}>{children}</View></View>; }
function Row({ title, detail, children, onPress, disabled = false, danger = false }: { title: string; detail?: string; children?: ReactNode; onPress?: () => void; disabled?: boolean; danger?: boolean }) {
  const content = <><View style={{ flex: 1, gap: 5 }}><Text style={[styles.rowTitle, danger && { color: '#ff6c88' }]}>{title}</Text>{detail && <Text style={ui.muted}>{detail}</Text>}</View>{children ?? (onPress && <Ionicons name="chevron-forward" size={18} color="#777c88" />)}</>;
  return onPress ? <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.row, disabled && { opacity: 0.5 }]}>{content}</Pressable> : <View style={styles.row}>{content}</View>;
}
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { clear, store, nickname, changed, preferences, setPreferences } = useMobile();
  const { loggedIn: douyinLoggedIn, nickname: douyinNickname, openLogin: openDouyinLogin, logout: logoutDouyin, checking: douyinChecking } = useDouyinSession();
  const [busy, setBusy] = useState(false); const [inspecting, setInspecting] = useState(true); const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState(''); const [dataError, setDataError] = useState(''); const [notice, setNotice] = useState('');
  const [icon, setIcon] = useState<string>('DEFAULT');
  const alive = useRef(true); const operation = useRef(false); const generation = useRef(0);
  async function inspect() {
    const request = ++generation.current; if (alive.current) { setInspecting(true); setDataError(''); }
    try { const [overview, database] = await Promise.all([store.accountOverview(), store.databaseBytes()]); const cache = cacheUsage(); if (alive.current && request === generation.current) setUsage({ overview, database, cache }); }
    catch { if (alive.current && request === generation.current) setDataError('数据占用读取失败，可点按重新检查。'); }
    finally { if (alive.current && request === generation.current) setInspecting(false); }
  }
  useEffect(() => { alive.current = true; void inspect(); return () => { alive.current = false; generation.current++; }; }, [store]);
  useEffect(() => { let running = true; void getAppIcon().then(name => { if (running && name) setIcon(name); }).catch(() => {}); return () => { running = false; }; }, []);
  async function pickIcon(name: string | null) {
    if (operation.current) return; operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await setAppIcon(name, true);
      if (!alive.current) return;
      if (result === false) setError('图标切换失败，请重试。');
      else {
        setIcon(result === 'DEFAULT' ? 'DEFAULT' : result);
        setNotice(name === null ? '已恢复默认图标，按 Home 退到桌面约 5 秒后生效' : `已选择「${ICON_LABELS[result] ?? result}」图标，按 Home 退到桌面约 5 秒后生效`);
      }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '图标切换失败，请重试。'); }
    finally { if (alive.current) setBusy(false); operation.current = false; }
  }
  async function action(task: () => Promise<string>) {
    if (operation.current) return; operation.current = true; setBusy(true); setError(''); setNotice('');
    try { const message = await task(); if (alive.current) setNotice(message); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '操作未完成，请重试。'); }
    finally { if (alive.current) { await inspect(); if (alive.current) setBusy(false); } operation.current = false; }
  }
  async function uploadIcon() {
    if (operation.current) return;
    const picked = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets || !picked.assets.length) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const base64 = await readAsStringAsync(picked.assets[0].uri, { encoding: 'base64' });
      const ok = await pinHomeShortcut('MyLike', base64);
      if (alive.current) setNotice(ok ? '已创建自定义图标的桌面快捷方式；如系统弹窗请点“添加”。' : '创建桌面快捷方式未完成，请重试。');
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '上传图标失败，请重试。'); }
    finally { if (alive.current) setBusy(false); operation.current = false; }
  }
  function confirm(kind: 'history' | 'searches' | 'library') {
    const title = kind === 'history' ? '清空观看历史？' : kind === 'searches' ? '清空搜索记录？' : '清空当前账号内容库？';
    const detail = kind === 'history' ? '将删除当前账号的观看历史和继续观看记录，作品、喜欢和收藏仍保留。' : kind === 'searches' ? '只删除当前账号的搜索关键词，不影响作品、喜欢、收藏或观看历史。' : `将删除 ${nickname} 的作品、导入关系、喜欢、收藏夹、搜索及观看记录。账号 ID 与播放偏好保留；其他本机账号和原始清单不受影响。恢复内容需要重新导入清单。`;
    Alert.alert(title, detail, [{ text: '取消', style: 'cancel' }, { text: '清空', style: 'destructive', onPress: () => { void action(async () => {
      if (kind === 'library') { await clear(); return '当前账号内容库已清空'; }
      if (kind === 'history') await store.removeHistory(); else await store.removeSearch(); changed(); return kind === 'history' ? '观看历史已清空' : '搜索记录已清空';
    }); } }]);
  }
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  return <View style={ui.screen}><PageHeader title="设置" back={onBack} /><ScrollView contentContainerStyle={styles.content}>
    <Section title={`当前账号 · ${nickname}`}>
      {usage ? <View style={styles.summary}><Text style={ui.text}>已导入 {usage.overview.all} · 喜欢 {usage.overview.likes} · 收藏 {usage.overview.favorites}</Text><Text style={ui.muted}>收藏夹 {usage.overview.folders} · 观看记录 {usage.overview.history} · 搜索记录 {usage.overview.searches}</Text></View> : inspecting ? <ActivityIndicator color="#aaa" style={{ padding: 18 }} /> : <View style={styles.summary}><Text style={ui.muted}>账号统计暂不可用，请重新检查数据占用。</Text></View>}
      <Row title="数据库占用" detail="估算值，不含其他账号、系统图片缓存与播放器缓冲。"><Text style={ui.muted}>{usage ? bytesLabel(usage.database) : '—'}</Text></Row>
      <Row title="清空搜索记录" disabled={busy || !usage?.overview.searches} onPress={() => confirm('searches')} />
      <Row title="清空观看历史" detail="同时移除继续观看记录。" disabled={busy || !usage?.overview.history} onPress={() => confirm('history')} />
      <Row title="清空内容库" detail="仅影响当前账号，清空前会再次确认。" danger disabled={busy} onPress={() => confirm('library')} />
      <Row title="清理缓存" detail="所有账号共用的临时缓存；保留内容、标记和进度。" disabled={busy} onPress={() => { void action(async () => { const result = clearPlaybackCache(); return result.failed ? `缓存已清理；${result.failed} 个临时文件暂不可删除，可稍后重试。` : '缓存已清理'; }); }}><Text style={ui.muted}>{usage ? bytesLabel(usage.cache.bytes) : '—'}</Text></Row>
      {!!dataError && <Row title={inspecting ? '正在读取…' : '重新检查数据占用'} disabled={busy || inspecting} onPress={() => { void inspect(); }} />}
    </Section>
    <Section title="抖音账号">
      <Row title={douyinLoggedIn ? `已登录${douyinNickname ? ` · ${douyinNickname}` : ''}` : '未登录'} detail={douyinLoggedIn ? '评论、楼中楼、点赞与收藏同步都使用此登录态' : '登录抖音后才能看完整评论、同步点赞和收藏'}>
        <Ionicons name={douyinLoggedIn ? 'checkmark-circle' : 'alert-circle'} size={20} color={douyinLoggedIn ? '#3ddc84' : '#e8c477'} />
      </Row>
      <Row title={douyinLoggedIn ? '重新登录' : '登录抖音'} detail={douyinChecking ? '检测中…' : (douyinLoggedIn ? '更换账号或刷新登录状态' : '打开抖音扫码登录')} disabled={douyinChecking} onPress={openDouyinLogin} />
      {douyinLoggedIn && <Row title="退出登录" detail="清除本机抖音登录状态" danger disabled={douyinChecking} onPress={() => { void logoutDouyin(); }} />}
    </Section>
    <Section title="外观">
      <Row title="评论区背景" detail={preferences.commentTheme === 'light' ? '浅色（白天模式）' : '深色（夜间模式）'} onPress={() => { void setPreferences({ commentTheme: preferences.commentTheme === 'light' ? 'dark' : 'light' }); }}>
        <Text style={ui.text}>{preferences.commentTheme === 'light' ? '浅色' : '深色'}</Text>
        <Ionicons name="swap-horizontal" size={18} color="#8a8f9a" style={{ marginLeft: 8 }} />
      </Row>
    </Section>
    <Section title="桌面图标">
      {ICON_OPTIONS.map(option => <Row key={option.name} title={option.label} detail={icon === option.name ? '当前使用中' : '点按切换到该图标'} disabled={busy} onPress={() => { void pickIcon(option.name); }}>
        {icon === option.name ? <Ionicons name="checkmark-circle" size={22} color="#3ddc84" /> : <View style={[styles.swatch, { backgroundColor: option.color }]} />}
      </Row>)}
      <Row title="恢复默认" detail="使用默认图标" disabled={busy} onPress={() => { void pickIcon(null); }}>
        {icon === 'DEFAULT' ? <Ionicons name="checkmark-circle" size={22} color="#3ddc84" /> : <Ionicons name="refresh" size={20} color="#8a8f9a" />}
      </Row>
      <Row title="上传自定义图标" detail="从相册/文件选一张图，生成带该图标的桌面快捷方式" disabled={busy} onPress={() => { void uploadIcon(); }}><Ionicons name="cloud-upload-outline" size={20} color="#8a8f9a" /></Row>
      <Row title="说明" detail="安卓需按 Home 退到桌面，约 5 秒后图标自动切换完成。" />
    </Section>
  </ScrollView>
    {!!(busy || notice || error || dataError) && <View pointerEvents="none" style={styles.feedback}><Text accessibilityLiveRegion="polite" style={[styles.notice, !!(error || dataError) && { color: '#ffc0cc' }]}>{busy ? '处理中…' : error || dataError || notice}</Text></View>}
  </View>;
}
const styles = StyleSheet.create({ feedback: { position: 'absolute', bottom: 12, left: 16, right: 16, padding: 14, backgroundColor: '#383c49', borderRadius: 10, zIndex: 5 }, swatch: { width: 22, height: 22, borderRadius: 11 }, content: { padding: 16, gap: 24, paddingBottom: 36 }, section: { gap: 10 }, sectionTitle: { color: '#a9acb6', fontSize: 13, marginLeft: 4 }, card: { borderRadius: 12, backgroundColor: '#20232d', overflow: 'hidden' }, row: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff08' }, rowTitle: { color: '#f0f0f3', fontSize: 15 }, summary: { padding: 16, gap: 8 }, notice: { color: '#b7d7c1', lineHeight: 21, fontSize: 13, textAlign: 'center' } });
