import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { MobileStore } from './store';
import { buildLikesLibrary } from './export-likes-format.ts';

// Export the works currently marked as "liked" on this device as a JSON file in
// the desktop MyLike import schema, then open the system share sheet so the file
// can be saved to storage and copied to a PC for import.
export async function exportLikesToFile(store: MobileStore): Promise<{ count: number; fileName: string }> {
  const rows = await store.likedExportRows();
  if (!rows.length) throw new Error('本机还没有喜欢的作品，先在“更多 → 从抖音更新点赞和收藏”同步一次。');
  const json = buildLikesLibrary(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `mylike-likes-${stamp}.json`;
  const cache = FileSystem.cacheDirectory;
  if (!cache) throw new Error('无法访问临时目录。');
  const uri = cache + fileName;
  await FileSystem.writeAsStringAsync(uri, json);
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持分享文件。');
  await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: '保存喜欢清单（可导入 PC 版 MyLike）' });
  return { count: rows.length, fileName };
}
