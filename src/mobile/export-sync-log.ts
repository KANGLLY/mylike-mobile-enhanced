import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { readSyncLogText } from './sync-log';

export async function exportSyncLogToFile(extraHeader?: string): Promise<{ fileName: string; lines: number }> {
  const body = readSyncLogText();
  const content = [extraHeader?.trim(), body].filter(Boolean).join('\n\n');
  if (!content.trim()) throw new Error('当前还没有同步日志，请先执行一次更新操作。');
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const fileName = `mylike-sync-log-${stamp}.txt`;
  const cache = FileSystem.cacheDirectory;
  if (!cache) throw new Error('无法访问临时目录。');
  const uri = cache + fileName;
  await FileSystem.writeAsStringAsync(uri, content);
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持导出文件。');
  await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: '导出同步诊断日志' });
  return { fileName, lines: content.split('\n').length };
}
