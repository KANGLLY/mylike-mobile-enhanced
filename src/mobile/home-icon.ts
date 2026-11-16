import { requireNativeModule } from 'expo';

let nativeModule: { pinHomeShortcut: (name: string, base64: string) => Promise<boolean> } | null = null;
try {
  nativeModule = requireNativeModule('HomeIcon');
} catch {
  nativeModule = null;
}

// Create a home-screen shortcut whose icon is the picked image. Android/iOS keep
// the true launcher icon as a build resource, so an arbitrary uploaded picture is
// surfaced through a pinned shortcut instead.
export async function pinHomeShortcut(name: string, base64: string): Promise<boolean> {
  if (!nativeModule) throw new Error('当前安装包未包含自定义图标功能，请更新到最新版后重试。');
  return await nativeModule.pinHomeShortcut(name, base64);
}

export function hasHomeIcon(): boolean {
  return Boolean(nativeModule);
}
