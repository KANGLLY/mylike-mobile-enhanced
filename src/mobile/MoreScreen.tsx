import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionSheet } from './ActionSheet';
import { ContinueCard } from './ContinueCard';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import { useSync } from './sync-context';
import { FolderSheet } from './FolderSheet';
import type { OpenQueue } from './LibraryScreen';
import { exportLikesToFile } from './export-likes';
import { exportSyncLogToFile } from './export-sync-log';
import { formatSyncDiagnostic, type CaptureMode } from './sync-library';
import { readSyncLogLines, readSyncLogText, subscribeSyncLog } from './sync-log';
import { Button, PageHeader, ui } from './ui';

type IconName = ComponentProps<typeof Ionicons>['name'];
type SyncKind = 'likes' | 'favorites';

export function MoreScreen({ onBack, onManage, onImport, onOpen, visible }: { onBack: () => void; onManage: (page: 'history' | 'settings') => void; onImport: () => void; onOpen: OpenQueue; visible: boolean }) {
  const [folders, setFolders] = useState(false);
  const [syncTarget, setSyncTarget] = useState<SyncKind | null>(null);
  const { store } = useMobile();
  const { openLogin, checkLogin, openCaptureVerify } = useDouyinSession();
  const { syncing, activeTarget, progress, checkpoints, start, cancel } = useSync();
  const [exporting, setExporting] = useState(false);
  const [exportingLog, setExportingLog] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [logCount, setLogCount] = useState(0);

  const buildLogHeader = () => {
    const parts: string[] = [];
    if (checkpoints.likes) {
      parts.push(`[喜欢断点] cursor=${checkpoints.likes.resumeCursor ?? 'null'} received=${checkpoints.likes.receivedCount} diag=${formatSyncDiagnostic(checkpoints.likes.diagnostic)}`);
    }
    if (checkpoints.favorites) {
      parts.push(`[收藏断点] cursor=${checkpoints.favorites.resumeCursor ?? 'null'} received=${checkpoints.favorites.receivedCount} diag=${formatSyncDiagnostic(checkpoints.favorites.diagnostic)}`);
    }
    return parts.join('\n');
  };

  useEffect(() => {
    if (!logOpen) return;
    const syncNow = () => {
      const text = readSyncLogText();
      const lines = readSyncLogLines();
      const header = buildLogHeader();
      setLogCount(lines.length);
      setLogText(header && text ? `${header}\n\n${text}` : text || header || '（暂无同步日志，请先运行一次“从抖音更新喜欢/收藏”或“从上次断点继续”）');
    };
    syncNow();
    return subscribeSyncLog(syncNow);
  }, [logOpen, checkpoints]);

  const doExportLogFile = async () => {
    if (exportingLog) return;
    setExportingLog(true);
    try {
      const res = await exportSyncLogToFile(buildLogHeader());
      Alert.alert('已生成日志文件', `文件：${res.fileName}（共 ${res.lines} 行），请在分享菜单选择“保存到文件”或直接发送。`);
    } catch (error) {
      Alert.alert('导出日志失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally { setExportingLog(false); }
  };

  const doShareLogText = async () => {
    try {
      await Share.share({ message: logText, title: 'MyLike 同步诊断日志' });
    } catch (error) {
      Alert.alert('分享失败', error instanceof Error ? error.message : '可直接长按上方文本框全选复制。');
    }
  };
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
  const label = progress ? (progress.stage === 'likes' ? '正在读取“我的喜欢”' : '正在读取“我的收藏”') : activeTarget === 'favorites' ? '正在连接“我的收藏”' : '正在连接“我的喜欢”';
  const engineHint = progress?.engine === 'direct' ? '直连极速分页' : progress?.engine === 'scroll' ? '页面滚动抓取' : '连接页面中';
  const activeCheckpoint = syncTarget ? checkpoints[syncTarget] : null;
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
    { label: '查看 / 导出同步日志', icon: 'document-text-outline', action: () => setLogOpen(true) },
    { label: '设置', icon: 'settings-outline', action: () => onManage('settings') },
  ];
  return <View style={ui.screen}><PageHeader title="更多" back={onBack} /><ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
    <ContinueCard visible={visible} onOpen={onOpen} />
    {links.map(link => <Pressable key={link.label} accessibilityRole="button" onPress={link.action} style={styles.link}><Ionicons name={link.icon} size={23} color="#eee" /><Text style={[ui.text, { flex: 1, fontSize: 16 }]}>{link.label}</Text><Ionicons name="chevron-forward" size={19} color="#888" /></Pressable>)}
  </ScrollView>{(syncing || progress) && <View style={styles.progress}><ActivityIndicator color="#fff" size="small" /><View style={{ flex: 1, gap: 2 }}><Text style={[ui.text, { fontSize: 14 }]}>{label}{progress ? ` · 已接收 ${progress.received} 条` : ''}</Text><Text style={[ui.muted, { fontSize: 12 }]}>{progress ? `第 ${progress.pages} 页（${engineHint}），每 10 页自动保存…点“取消更新”保留断点` : '正在加载抖音页面并准备抓取，请稍候…'}</Text></View><Pressable accessibilityRole="button" onPress={openCaptureVerify} hitSlop={8} style={styles.verifyBtn}><Text style={styles.verifyBtnText}>验证/查看</Text></Pressable></View>}
    <ActionSheet visible={syncTarget !== null} title={syncTarget === 'favorites' ? '从抖音更新收藏' : '从抖音更新喜欢'} onClose={() => setSyncTarget(null)}>
      <Text style={ui.muted}>{syncTarget === 'favorites' ? '选择“我的收藏”采集范围，更新过程每 10 页自动入库并记录断点。' : '选择“我的喜欢”采集范围，更新过程每 10 页自动入库并记录断点。'}</Text>
      {activeCheckpoint?.diagnostic && <View style={styles.diagBox}><Text style={styles.diagTitle}>上次诊断</Text><Text style={styles.diagText}>{formatSyncDiagnostic(activeCheckpoint.diagnostic)}</Text></View>}
      <View style={styles.syncOptions}>
        {activeCheckpoint?.resumeCursor && <Button title={`从上次断点继续（已抓 ${activeCheckpoint.receivedCount} 条）`} selected onPress={() => launchSync('resume')} />}
        <Button title="更新顶部（只补最新）" onPress={() => launchSync('top')} />
        <Button title="向下采集（继续更旧）" onPress={() => launchSync('down')} />
        <Button title="整体更新（从头到尾一遍）" selected={!activeCheckpoint?.resumeCursor} onPress={() => launchSync('full')} />
      </View>
      <Button title="取消" onPress={() => setSyncTarget(null)} />
    </ActionSheet>
    <Modal visible={logOpen} transparent animationType="fade" onRequestClose={() => setLogOpen(false)}>
      <View style={styles.logBackdrop}>
        <View style={styles.logCard}>
          <View style={styles.logHeader}>
            <Text style={styles.logTitle}>同步诊断日志（{logCount} 行）</Text>
            <Pressable accessibilityRole="button" onPress={() => setLogOpen(false)} hitSlop={10}>
              <Ionicons name="close" size={22} color="#bababb" />
            </Pressable>
          </View>
          <TextInput
            multiline
            editable={false}
            selectTextOnFocus
            value={logText}
            textAlignVertical="top"
            style={styles.logInput}
          />
          <View style={styles.logActions}>
            <Button title={exportingLog ? '导出中…' : '导出 .txt 日志'} selected onPress={() => { void doExportLogFile(); }} />
            <Button title="分享 / 复制文本" onPress={() => { void doShareLogText(); }} />
            <Button title="关闭" onPress={() => setLogOpen(false)} />
          </View>
        </View>
      </View>
    </Modal>
    {folders && <FolderSheet manage onClose={() => setFolders(false)} />}</View>;
}
const styles = StyleSheet.create({
  link: { marginHorizontal: 20, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff12' },
  progress: { position: 'absolute', bottom: 14, left: 16, right: 16, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#383c49', flexDirection: 'row', alignItems: 'center', gap: 12, zIndex: 5 },
  syncOptions: { gap: 10 },
  diagBox: { padding: 10, borderRadius: 8, backgroundColor: '#ffffff0d', gap: 4 },
  diagTitle: { color: '#bababb', fontSize: 12, fontWeight: '600' },
  diagText: { color: '#e3e4ea', fontSize: 12, lineHeight: 17 },
  verifyBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#ffffff1c' },
  verifyBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  logBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'center', padding: 16 },
  logCard: { backgroundColor: '#1f222d', borderRadius: 14, padding: 14, gap: 12, maxHeight: '85%' },
  logHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  logInput: { minHeight: 240, maxHeight: 380, backgroundColor: '#14161e', color: '#dfe3ec', borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 16 },
  logActions: { gap: 8 },
});
