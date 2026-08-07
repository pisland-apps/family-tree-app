# 家谱 · 家族树 (Family Tree)

一个纯前端的家谱管理应用：多家族树、父母/配偶/子女关系（含继父母、一夫多妻等特殊情况）、拖拽调整顺序、收起/展开、聚焦查看、家族分布地图、撤销/前进后退、ZIP 导出导入（含照片）。

支持离线使用（Service Worker）和可安装为桌面/手机应用（PWA）。已按 [CSP-HARDENING-PLAYBOOK.md] 加固：严格 CSP、外部 `app.js`（不用内联脚本 hash 锁定）、CDN 脚本 SRI 校验、`id`/照片字段一律转义防属性注入 XSS。

## 目录结构

```
family-tree-app/
├── index.html          主应用界面（含 CSP meta 标签），逻辑已拆到 app.js
├── app.js               应用逻辑（拆分出来是为了让 CSP 能禁用内联脚本，见下方"部署须知"）
├── manifest.json        PWA 配置（应用名称、图标、主题色）
├── service-worker.js     离线缓存
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## 部署须知（重要）

- **`index.html` 和 `app.js` 必须一起部署**，只传 `index.html` 会导致白屏（浏览器加载不到脚本，且 CSP 不允许内联回退）。
- 本应用通过 `<meta http-equiv="Content-Security-Policy">` 设置了严格 CSP。**`frame-ancestors` 无法通过 `<meta>` 生效**（浏览器只认 HTTP 响应头设置的这个指令），GitHub Pages 不支持自定义响应头，所以点击劫持防护在这个部署方式下无法强制生效——如果这一点对你很重要，需要换到支持自定义响应头的托管（如 Cloudflare Pages / Netlify 的 `_headers` 文件）。
- 请用本地 HTTP 服务器测试（如 `python3 -m http.server 8000`），不要用双击打开文件的方式（`file://` 协议下 `'self'` 的同源判断会失真，导致本来没问题的资源被 CSP 拦掉）。

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库（比如叫 `family-tree`），把这个文件夹里的所有文件上传上去（保持目录结构，`icons/` 文件夹也要一起传）。
2. 仓库页面 → **Settings** → **Pages**。
3. **Source** 选择 `Deploy from a branch`，分支选 `main`（或你放代码的那个分支），目录选 `/ (root)`。
4. 保存后等 1-2 分钟，GitHub 会给你一个网址，形如：
   `https://你的用户名.github.io/family-tree/`
5. 打开这个网址即可使用。手机浏览器打开后，可以用"添加到主屏幕"把它当App一样安装；电脑上 Chrome/Edge 地址栏右侧会出现"安装"图标，点了也能装成桌面应用。

> 也可以不用 GitHub Pages，直接把 `index.html` 双击用浏览器打开使用——所有功能一样正常，只是这种情况下 Service Worker 不会启用（需要 http/https 协议才能注册），也没法"安装"成应用，纯粹是本地文件模式。

## 应用锁（密码保护）

第一次打开会要求设置一个访问密码。之后所有资料（家谱数据 + 照片）都会用这个密码通过 **PBKDF2** 推算出的密钥，以 **AES-GCM** 加密后才存进本机（localStorage / IndexedDB）。

**重要提醒：**
- 密码本身完全不会被保存下来（只存了一个用来验证密码对不对的"校验值"和一个随机盐值），**忘记密码 = 数据无法恢复**，因为没有密码就没办法算出解密用的密钥。
- 请务必牢记密码，并**定期用"导出"功能备份成 .zip**（导出的备份文件本身是明文的，方便分享/在别的设备打开，不受这个密码限制）。
- 顶部工具栏可以"锁定"（立即退出，下次要重新输入密码）或"🔑 更改密码"（需要记得旧密码）。

## 数据存放在哪里

- **人物、家族树等资料**：存在浏览器的 `localStorage`（或者 Claude 环境下的 `window.storage`），大概几MB以内。
- **照片**：存在浏览器的 **IndexedDB**（专门存二进制数据的浏览器数据库），容量比 localStorage 大得多，不会因为存几张照片就爆掉。
- 以上数据都是"**这台设备、这个浏览器**"本地的，换设备/换浏览器不会自动同步。**请定期用顶部"导出"功能打包成 .zip 备份**（里面包含所有资料和照片），换设备时用"导入"读回来即可。

## 关于外部资源

应用运行时会从公开 CDN 加载两样东西（可以正常联网时才会用到）：
- [JSZip](https://cdnjs.cloudflare.com)：导出/导入 ZIP 文件用。
- [flekschas/simple-world-map](https://github.com/flekschas/simple-world-map)（CC BY-SA 协议）：家族分布地图用的世界地图。

如果打开时没有网络，导出导入功能和"真实世界地图"会暂时用不了或自动退回到简化版本，但家谱树本身的浏览、编辑、拖拽等核心功能不受影响（配合 Service Worker，首次联网访问后，这些外部资源大多也会被缓存下来供离线使用）。

## 更新须知（重要）

每次改了 `index.html`（或其他任何文件）之后，一定要把 `service-worker.js` 里的 `CACHE_VERSION` 数值改一下（比如 `family-tree-v1` → `family-tree-v2`），哪怕只改一个数字都行。

原因：Service Worker 判断"要不要更新缓存"，是靠对比 `service-worker.js` **这个文件本身**的内容有没有变化。如果这个文件一个字节都没动，浏览器会认为没有更新，已经打开/安装过这个应用的用户会继续看到旧版本，感觉不到你的改动——直到清缓存或者卸载重装为止。改一下版本号，就相当于让这个文件的内容发生了变化，浏览器才会重新抓取最新的文件。

## 关于 Claude Code 集成开发

如果之后想继续用 Claude 帮你改这个项目，用 [Claude Code](https://docs.claude.com) 在本地打开这个文件夹，直接说需求即可（比如"帮我加一个XX功能"），不需要每次都整份贴代码。
