import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionSheet } from './ActionSheet';
import { ContinueCard } from './ContinueCard';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import { useSync } from './sync-context';
import { FolderSheet } from './FolderSheet';
import type { OpenQueue } from './LibraryScreen';
import { exportLikesToFile } from './export-likes';
import type { CaptureMode } from './sync-library';
import { Button, PageHeader, ui } from './ui';

type IconName = ComponentProps<typeof Ionicons>['name'];
type SyncKind = 'likes' | 'favorites';

export function MoreScreen({ onBack, onManage, onImport, onOpen, visible }: { onBack: () => void; onManage: (page: 'history' | 'settings') => void; onImport: () => void; onOpen: OpenQueue; visible: boolean }) {
  const [folders, setFolders] = useState(false);
  const [syncTarget, setSyncTarget] = useState<SyncKind | null>(null);
  const { store } = useMobile();
  const { openLogin, checkLogin } = useDouyinSession();
  const { syncing, activeTarget, progress, start, cancel } = useSync();
  const [exporting, setExporting] = useState(false);
  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportLikesToFile(store);
      Alert.alert('已导出', `已生成喜欢清单（${result.count} 条），选择“保存到文件”即可拷到电脑导入 PC 版。`);
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally { setExporting(false); }
  };
  const onUpdate = async (kind: SyncKind) => {
    if (syncing) { cancel(); return; }
    const ok = await checkLogin(true);
    if (!ok) {
      openLogin();
      Alert.alert('需要登录', `请先在弹出的页面登录抖音，登录成功后再点一次“${kind === 'likes' ? '从抖音更新喜欢' : '从抖音更新收藏'}”。`);
      return;
    }
    setSyncTarget(kind);
  };
  const launchSync = (mode: CaptureMode) => {
    const target = syncTarget;
    setSyncTarget(null);
    if (target) void start(mode, target);
  };
  const label = progress ? (progress.stage === 'likes' ? '正在读取“我的喜欢”' : '正在读取“我的收藏”') : '';
  const links: { label: string; icon: IconName; action: () => void }[] = [
    { label: '观看历史', icon: 'time-outline', action: () => onManage('history') },
    { label: '管理收藏夹', icon: 'folder-outline', action: () => setFolders(true) },
    { label: '导入清单', icon: 'download-outline', action: onImport },
    { label: exporting ? '正在导出…' : '导出喜欢的作品（JSON）', icon: 'share-outline', action: () => { void doExport(); } },
    {
      label: syncing && (activeTarget === 'likes' || activeTarget === 'both') ? '取消更新喜欢' : '从抖音更新喜欢',
      icon: syncing && (activeTarget === 'likes' || activeTarget === 'both') ? 'close-circle-outline' : 'heart-outline',
      action: () => { void onUpdate('likes'); },
    },
    {
      label: syncing && (activeTarget === 'favorites' || activeTarget === 'both') ? '取消更新收藏' : '从抖音更新收藏',
      icon: syncing && (activeTarget === 'favorites' || activeTarget === 'both') ? 'close-circle-outline' : 'star-outline',
      action: () => { void onUpdate('favorites'); },
    },
    { label: '设置', icon: 'settings-outline', action: () => onManage('settings') },
  ];
  return <View style={ui.screen}><PageHeader title="更多" back={onBack} /><ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
    <ContinueCard visible={visible} onOpen={onOpen} />
    {links.map(link => <Pressable key={link.label} accessibilityRole="button" onPress={link.action} style={styles.link}><Ionicons name={link.icon} size={23} color="#eee" /><Text style={[ui.text, { flex: 1, fontSize: 16 }]}>{link.label}</Text><Ionicons name="chevron-forward" size={19} color="#888" /></Pressable>)}
  </ScrollView>{progress && <View style={styles.progress}><ActivityIndicator color="#fff" size="small" /><View style={{ flex: 1, gap: 2 }}><Text style={[ui.text, { fontSize: 14 }]}>{label} · 已接收 {progress.received} 条</Text><Text style={[ui.muted, { fontSize: 12 }]}>第 {progress.pages} 页，边抓边更新…（退出本页会继续，点“取消更新”才停止）</Text></View></View>}
    <ActionSheet visible={syncTarget !== null} title={syncTarget === 'favorites' ? '从抖音更新收藏' : '从抖音更新喜欢'} onClose={() => setSyncTarget(null)}>
      <Text style={ui.muted}>{syncTarget === 'favorites' ? '选择“我的收藏”采集范围，更新过程在后台运行可随时取消。' : '选择“我的喜欢”采集范围，整体更新会从头到尾完整扫描一遍。'}</Text>
      <View style={styles.syncOptions}>
        <Button title="更新顶部（只补最新）" onPress={() => launchSync('top')} />
        <Button title="向下采集（继续更旧）" onPress={() => launchSync('down')} />
        <Button title="整体更新（从头到尾一遍）" selected onPress={() => launchSync('full')} />
      </View>
      <Button title="取消" onPress={() => setSyncTarget(null)} />
    </ActionSheet>
    {folders && <FolderSheet manage onClose={() => setFolders(false)} />}</View>;
}
const styles = StyleSheet.create({
  link: { marginHorizontal: 20, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff12' },
  progress: { position: 'absolute', bottom: 14, left: 16, right: 16, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#383c49', flexDirection: 'row', alignItems: 'center', gap: 12, zIndex: 5 },
  syncOptions: { gap: 10 },
});
