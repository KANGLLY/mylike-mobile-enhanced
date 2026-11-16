<div align="center">

<img src="assets/readme/logo.svg" width="120" alt="MyLike Logo" />

# MyLike 移动端

**在 Android 上回看你的喜欢。**

导入 MyLike 桌面端的喜欢与收藏清单，随时查找、播放和续看。

[![Android](https://img.shields.io/badge/Android-APK-3ddc84?style=flat-square)](https://github.com/KANGLLY/mylike-mobile-enhanced/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-6bb99b?style=flat-square)](LICENSE)

[下载应用](https://github.com/KANGLLY/mylike-mobile-enhanced/releases) · [功能特性](#功能特性) · [界面预览](#界面预览) · [快速上手](#快速上手) · [反馈问题](https://github.com/KANGLLY/mylike-mobile-enhanced/issues)

</div>

> **声明：** 本仓库为基于 [Hannah2227/MyLike](https://github.com/Hannah2227/mylike-mobile)（MIT，Copyright © 2026 MyLike）的修改版（非官方 / unofficial）。
> 原作品版权归原作者所有；本版遵循 MIT 许可证，详见仓库 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

## 界面预览

<div align="center">
<table>
  <tr>
    <th>播放页</th>
    <th>内容库</th>
  </tr>
  <tr>
    <td><img src="assets/readme/playback.svg?v=1.0.2" width="280" alt="MyLike 播放页示意" /></td>
    <td><img src="assets/readme/library.svg?v=1.0.2" width="280" alt="MyLike 内容库示意" /></td>
  </tr>
</table>
</div>

## 下载

前往 [GitHub Releases](https://github.com/KANGLLY/mylike-mobile-enhanced/releases) 下载。



### Android

下载 `.apk`，在手机上打开文件并按系统提示安装。

## 功能特性

**本版新增 / 增强（相对原版 MyLike）：**

- **完整评论区** — 登录抖音后可查看全部评论并翻页；楼中楼回复首次展开 3 条、之后每次 10 条，可「展开更多 / 收起」，回复缩进区分。
- **评论主题与表情** — 评论区支持深色 / 浅色两套背景；评论内联显示抖音原生小表情，支持表情包 / 大表情与图片评论缩略图。
- **点赞 / 收藏同步** — 登录后把「我的喜欢 / 我的收藏」同步到本机，支持「更新顶部（只补最新）」「向下采集（继续更旧）」，可后台继续、显示进度、随时取消。
- **导出清单** — 把喜欢的作品导出为 JSON，可导入 PC 桌面版 MyLike。
- **播放增强** — 长按二倍速（竖屏 / 全屏）、横向视频「全屏观看」（画面放大不旋转整机）、可开关弹幕。
- **保存到相册** — 长按菜单可把视频、图集图片、音频保存到手机。
- **细节优化** — 同一视频的评论关闭再打开不重新加载；默认爱心桌面图标。

**原版功能（MyLike 自带）：**

- **清单导入** — 支持桌面端导出的喜欢和收藏 JSON，预览新增与重复条数，按作品 ID 合并，保留收藏夹关系。
- **本机管理** — 喜欢、收藏与收藏夹在手机上独立管理，支持多个本机账号空间，不修改抖音账号状态。
- **随手找到** — 三列封面浏览，支持按标题或作者搜索，以及按作品类型和发布时间筛选。
- **滑动回看** — 上下滑切换作品，图集内左右滑翻页。支持视频、图集配乐和有可用片段的实况图集。
- **播放队列** — 点开封面顺序播放，或把当前筛选结果随机排列。可切换自动连播、倍速和清屏。
- **播放手势** — 点按暂停，双击喜欢；两侧长按临时清屏 2 倍速，下拉到底部可锁定或解除倍速。支持双指缩放，松手复原。
- **断点续播** — 记录上次作品、视频时间或图集页码，在「我 → 更多」继续观看或查看历史。

## 快速上手

1. **准备清单** — 在 MyLike 桌面版导出喜欢或收藏 JSON。
2. **导入手机** — 把 JSON 保存到手机的「文件」或「下载」。在「我」中选好本机账号，再点底部「＋」导入。
3. **开始回看** — 首页浏览已导入作品，或在「我」中按全部、喜欢、收藏夹查找，点封面回看，也可随机播放。拖动视频底部可跳转，长按画面中间可打开播放选项。

从 v1.0.0 升级后，原作品仍保留在「我 → 全部」，旧观看进度不迁移；重新导入当前桌面清单可补齐喜欢与收藏来源。覆盖安装需沿用相同应用标识与签名；卸载会移除设备上的本地数据。

播放时需要联网，手机会按作品 ID 实时获取媒体地址，无需登录抖音。遇到作品失效或接口受限时，可以重试或划到下一条。

## 开发

使用 React Native、TypeScript、Expo SDK 58 和 SQLite。构建工作流使用 Node.js 24.12.0。

```sh
npm ci
npm start
```

使用支持 SDK 58 的 Expo Go 调试。普通启动和 Actions 共用首页／导入／我的入口；`npm run start:m1` 为 8083 端口的启动别名。`npm run typecheck` 检查类型，`npm test` 运行测试。维护者可在 Actions 手动运行 **Build Android test APK**，在 Artifacts 获取独立测试包。 [Expo Go](https://expo.dev/go) · [构建工作流](https://github.com/Hannah2227/mylike-mobile/actions)

## 免责声明

- **项目关系** — MyLike 移动端是独立开发的个人回看工具，与抖音及字节跳动无关联，也未获其授权或背书。
- **内容与授权** — 请仅导入本人或已获授权的清单，遵守适用法律法规、平台服务条款和内容权利人的授权范围。视频、图片、音乐及平台标识的权利归各自权利人所有。转载、传播或商业使用须取得相应授权。
- **数据与隐私** — 内容库和观看进度保存在设备上。分享清单或提交问题前，请检查作品列表及截图中是否包含不愿公开的信息，并保留原始清单以便重装后恢复内容库。
- **可用性与责任** — 播放依赖网络、作品状态和第三方接口。作品下架、接口调整或访问受限可能影响播放。软件按现状提供，担保及责任限制以适用法律和 [MIT License](LICENSE) 为准。

## 许可证

本项目的源代码和文档采用 [MIT License](LICENSE)。第三方组件适用各自的许可证。
