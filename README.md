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
├── _headers              Cloudflare Pages 专用：自定义响应头（详见下方"部署到 Cloudflare Pages"）
├── assets/
│   └── world-map.svg    家族分布地图用的世界地图底图（打包在本地，不再从 CDN 拉取）
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## 部署须知（重要）

- **`index.html` 和 `app.js` 必须一起部署**，只传 `index.html` 会导致白屏（浏览器加载不到脚本，且 CSP 不允许内联回退）。
- 本应用通过 `<meta http-equiv="Content-Security-Policy">` 设置了严格 CSP，作为兜底（比如直接双击用 `file://` 打开时依然有效）。但 **`frame-ancestors` 无法通过 `<meta>` 生效**（浏览器只认 HTTP 响应头设置的这个指令）——如果部署在 GitHub Pages（不支持自定义响应头），点击劫持防护就无法强制生效。仓库里已经带了一份 `_headers` 文件，部署到 **Cloudflare Pages** 后会自动生效，把 `frame-ancestors` 等安全响应头一起补上（见下方"部署到 Cloudflare Pages"）。
- 请用本地 HTTP 服务器测试（如 `python3 -m http.server 8000`），不要用双击打开文件的方式（`file://` 协议下 `'self'` 的同源判断会失真，导致本来没问题的资源被 CSP 拦掉）。

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库（比如叫 `family-tree`），把这个文件夹里的所有文件上传上去（保持目录结构，`icons/` 文件夹也要一起传）。
2. 仓库页面 → **Settings** → **Pages**。
3. **Source** 选择 `Deploy from a branch`，分支选 `main`（或你放代码的那个分支），目录选 `/ (root)`。
4. 保存后等 1-2 分钟，GitHub 会给你一个网址，形如：
   `https://你的用户名.github.io/family-tree/`
5. 打开这个网址即可使用。手机浏览器打开后，可以用"添加到主屏幕"把它当App一样安装；电脑上 Chrome/Edge 地址栏右侧会出现"安装"图标，点了也能装成桌面应用。

> 也可以不用 GitHub Pages，直接把 `index.html` 双击用浏览器打开使用——所有功能一样正常，只是这种情况下 Service Worker 不会启用（需要 http/https 协议才能注册），也没法"安装"成应用，纯粹是本地文件模式。

## 部署到 Cloudflare Pages

比 GitHub Pages 多一个好处：Cloudflare Pages 支持自定义响应头，仓库根目录下的 `_headers` 文件会被自动读取并生效——不需要额外配置，把它和其他文件一起传上去就行。这样 `frame-ancestors`（点击劫持防护）等只能通过 HTTP 头设置的指令才能真正生效，而不只是 `<meta>` 标签里那份兜底版本。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **创建应用程序** → **Pages** → **连接到 Git**（或者用 **直接上传** 方式，把整个文件夹拖进去也可以，不一定要走 Git）。
2. 如果用 Git 集成：选好仓库后，构建设置全部留空即可（**Build command** 留空，**Build output directory** 填 `/`，本项目是纯静态文件，不需要构建步骤）。
3. 部署完成后会拿到一个 `*.pages.dev` 的网址；如果有自己的域名，可以在 Pages 项目里绑定自定义域名。
4. 想确认 `_headers` 真的生效了：打开浏览器开发者工具 → Network 面板 → 点开 `index.html` 这个请求 → 看 Response Headers 里有没有 `content-security-policy` 这一项（值应该包含 `frame-ancestors 'none'`）。

从 GitHub Pages 迁移过来的话，直接把同一批文件（包括新增的 `_headers`）传到 Cloudflare Pages 即可，`index.html` / `app.js` 等文件内容完全不用改。

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

应用运行时只有一样东西还依赖公开 CDN（可以正常联网时才会用到）：
- [JSZip](https://cdnjs.cloudflare.com)：导出/导入 ZIP 文件用，带 SRI 完整性校验。

家族分布地图用的世界地图 SVG（[flekschas/simple-world-map](https://github.com/flekschas/simple-world-map)，CC BY-SA 协议）现在**打包在应用内**（`assets/world-map.svg`），不再从 CDN 的 `@master`（可变引用，内容随时可能变化且无完整性校验）实时拉取。这样一次改动即可避免"上游仓库或 CDN 被篡改后应用会不加验证地渲染新内容"的风险，也省去了打开地图视图时向第三方 CDN 发起请求（连带暴露访问者 IP）的问题。地图版权归属仍保留在地图视图的角标里。

如果打开时没有网络，导出导入功能会暂时用不了，但家谱树浏览/编辑/拖拽和家族分布地图（含世界地图底图）都不受影响，因为这些都是本地资源，会被 Service Worker 预缓存。

## 更新须知（重要）

每次改了 `index.html` / `app.js`（或其他任何文件）之后，两件事都要做：

1. **`service-worker.js` 里的 `CACHE_VERSION`** 数值改一下（比如 `family-tree-v5` → `family-tree-v6`），哪怕只改一个数字都行。
   原因：Service Worker 判断"要不要更新缓存"，是靠对比 `service-worker.js` **这个文件本身**的内容有没有变化。如果这个文件一个字节都没动，浏览器会认为没有更新，已经打开/安装过这个应用的用户会继续看到旧版本，感觉不到你的改动——直到清缓存或者卸载重装为止。改一下版本号，就相当于让这个文件的内容发生了变化，浏览器才会重新抓取最新的文件。
   （部署在 Cloudflare Pages 上时，`_headers` 文件已经给 `service-worker.js` 设置了 `Cache-Control: no-cache`，让浏览器每次都向 Cloudflare 边缘节点确认这个文件有没有变——这样"改版本号→浏览器能感知到"这条链路才不会被 CDN 缓存打断。）
2. **`app.js` 顶部的 `APP_VERSION`**（和 `APP_VERSION_DATE`）也同步改一下。这个值会显示在页面右下角一个不起眼的小灰字上——锁屏界面就能看到，不用先解锁。它跟 `CACHE_VERSION`是两个独立的字符串，分别放在两个文件里，**不会自动同步**，纯粹是给你自己核对"现在打开的是不是最新版"用的，改错了也不影响任何功能。

判断是否更新到最新版的方法：打开页面，看右下角版本号是不是你这次改的值。如果不是，先强制刷新（Ctrl/Cmd+Shift+R）或者到浏览器开发者工具里手动清一下这个站点的缓存和 Service Worker 再试。

## 关于 Claude Code 集成开发

如果之后想继续用 Claude 帮你改这个项目，用 [Claude Code](https://docs.claude.com) 在本地打开这个文件夹，直接说需求即可（比如"帮我加一个XX功能"），不需要每次都整份贴代码。
