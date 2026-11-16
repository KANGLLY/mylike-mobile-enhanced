import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ContinueCard } from './ContinueCard';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import { FolderSheet } from './FolderSheet';
import type { OpenQueue } from './LibraryScreen';
import { syncDouyinLibrary } from './sync-library';
import { exportLikesToFile } from './export-likes';
import { PageHeader, ui } from './ui';

export function MoreScreen({ onBack, onManage, onImport, onOpen, visible }: { onBack: () => void; onManage: (page: 'history' | 'settings') => void; onImport: () => void; onOpen: OpenQueue; visible: boolean }) {
  const [folders, setFolders] = useState(false);
  const { store, changed } = useMobile();
  const { captureCollection, openLogin, checkLogin } = useDouyinSession();
  const [syncing, setSyncing] = useState(false);
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
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // 先复检登录态：重启后 cookie 可能还在，但内存 loggedIn 已重置为 false。
      const ok = await checkLogin(true);
      if (!ok) {
        openLogin();
        Alert.alert('需要登录', '请先在弹出的页面登录抖音，登录成功后再点一次“从抖音更新点赞和收藏”。');
        return;
      }
      const result = await syncDouyinLibrary(captureCollection, store.importCollection);
      changed();
      Alert.alert('已更新', `点赞 ${result.liked} 条，收藏 ${result.saved} 条已同步到本机。`);
    } catch (error) {
      Alert.alert('更新失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally { setSyncing(false); }
  };
  const links = [
    { label: '观看历史', icon: 'time-outline' as const, action: () => onManage('history') },
    { label: '管理收藏夹', icon: 'folder-outline' as const, action: () => setFolders(true) },
    { label: '导入清单', icon: 'download-outline' as const, action: onImport },
    { label: exporting ? '正在导出…' : '导出喜欢的作品（JSON）', icon: 'share-outline' as const, action: () => { void doExport(); } },
    { label: syncing ? '正在从抖音更新…' : '从抖音更新点赞和收藏', icon: 'sync-outline' as const, action: () => { void sync(); } },
    { label: '设置', icon: 'settings-outline' as const, action: () => onManage('settings') },
  ];
  return <View style={ui.screen}><PageHeader title="更多" back={onBack} /><ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
    <ContinueCard visible={visible} onOpen={onOpen} />
    {links.map(link => <Pressable key={link.label} accessibilityRole="button" onPress={link.action} style={styles.link}><Ionicons name={link.icon} size={23} color="#eee" /><Text style={[ui.text, { flex: 1, fontSize: 16 }]}>{link.label}</Text><Ionicons name="chevron-forward" size={19} color="#888" /></Pressable>)}
  </ScrollView>{folders && <FolderSheet manage onClose={() => setFolders(false)} />}</View>;
}
const styles = StyleSheet.create({ link: { marginHorizontal: 20, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff12' } });
