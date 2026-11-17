import ExpoModulesCore
import Foundation
import WebKit

public final class HomeIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HomeIcon")

    // Clear both WKWebsiteDataStore cookies (used by WKWebView) and HTTPCookieStorage
    // so "退出登录" on iOS drops the Douyin session just like Android CookieManager.
    AsyncFunction("clearCookies") { (promise: Promise) in
      let storage = HTTPCookieStorage.shared
      for cookie in storage.cookies ?? [] {
        storage.deleteCookie(cookie)
      }
      let store = WKWebsiteDataStore.default()
      store.removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast) {
        promise.resolve(true)
      }
    }
    .runOnQueue(.main)
  }
}
