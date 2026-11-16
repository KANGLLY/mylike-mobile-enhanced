import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ContinueCard } from './ContinueCard';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import { FolderSheet } from './FolderSheet';
import type { OpenQueue } from './LibraryScreen';
import { syncDouyinLibrary } from './sync-library';
import { PageHeader, ui } from './ui';

export function MoreScreen({ onBack, onManage, onImport, onOpen, visible }: { onBack: () => void; onManage: (page: 'history' | 'settings') => void; onImport: () => void; onOpen: OpenQueue; visible: boolean }) {
  const [folders, setFolders] = useState(false);
  const { store, changed } = useMobile();
  const { request, loggedIn, openLogin } = useDouyinSession();
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    if (syncing) return;
    if (!loggedIn) { openLogin(); return; }
    setSyncing(true);
    try {
      const result = await syncDouyinLibrary((operation, parameters) => request(operation, parameters), store.importCollection);
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
    { label: syncing ? '正在从抖音更新…' : '从抖音更新点赞和收藏', icon: 'sync-outline' as const, action: () => { void sync(); } },
    { label: '设置', icon: 'settings-outline' as const, action: () => onManage('settings') },
  ];
  return <View style={ui.screen}><PageHeader title="更多" back={onBack} /><ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
    <ContinueCard visible={visible} onOpen={onOpen} />
    {links.map(link => <Pressable key={link.label} accessibilityRole="button" onPress={link.action} style={styles.link}><Ionicons name={link.icon} size={23} color="#eee" /><Text style={[ui.text, { flex: 1, fontSize: 16 }]}>{link.label}</Text><Ionicons name="chevron-forward" size={19} color="#888" /></Pressable>)}
  </ScrollView>{folders && <FolderSheet manage onClose={() => setFolders(false)} />}</View>;
}
const styles = StyleSheet.create({ link: { marginHorizontal: 20, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff12' } });
