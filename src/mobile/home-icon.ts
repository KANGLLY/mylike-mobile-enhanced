import { requireNativeModule } from 'expo';

let nativeModule: { clearCookies: () => Promise<boolean> } | null = null;
try {
  nativeModule = requireNativeModule('HomeIcon');
} catch {
  nativeModule = null;
}

// Clear the WebView cookie jar so "退出登录" actually drops the Douyin session.
export async function clearWebViewCookies(): Promise<boolean> {
  if (!nativeModule) return false;
  try { return await nativeModule.clearCookies(); } catch { return false; }
}
