# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整的历史版本说明见
[Releases](https://github.com/tanhx-boy/LanBridge/releases)。

---

## v2.1.0

本次以**修复与体验打磨**为主：修掉一个会让聊天图片全部 404 的路径缺陷，收紧了在线预览的
安全边界，补上应用图标，并改进了构建流程与网络地址的展示。

### 新增

- **应用图标与网页图标**：`app.ico` 同时作为 exe 图标与浏览器标签页图标。favicon 在构建时
  从 `app.ico` 自动裁出小尺寸，422KB → 17KB，避免网页多传无用数据、也避免同一份数据在
  exe 内重复存储
- **聊天图片点击放大**：消息里的图片支持页内全屏预览，点击遮罩、关闭按钮或按 `Esc` 关闭
- **构建失败可定位**：`tools/build.ps1` 会打印定位到的 VS / MSVC / SDK 路径，失败时明确指出
  是哪一步、哪个路径有问题

### 改进

- **在线预览收窄为仅图片**：png / jpg / jpeg / gif / webp / bmp / ico 可内联打开并校验文件
  真实内容；txt、md、json、log、csv、ini、pdf 不再内联预览，一律下载到本机后打开
- **控制台地址列表更干净**：过滤掉 APIPA 地址（`169.254.x.x`，未获取到 DHCP 时的回退地址）
  与未连接的网卡；虚拟网卡（VMware / VirtualBox / Hyper-V / WSL）单独归为 `Virtual:` 并排在
  最后；若过滤后一个地址都不剩，会回退打印全部网卡并给出提示
- **控制台提示改为中文**
- **构建不再依赖 `vcvars64.bat`**：该链路会通过 `reg.exe` 查询注册表来定位 VS 与 Windows SDK，
  在启用了程序黑名单或受限沙箱的机器上，`reg.exe` 被拦截会导致 vcvars 中途失败——既不设置
  `INCLUDE`/`LIB` 也不返回错误码，表现为构建静默中断。现在改为自行定位工具链并直接设置环境
- **SSE 长连接增加并发上限与失败退避**：每个在线连接会独占一个工作线程，此前约 16 人同时在线
  即可能占满线程池、拖垮文件传输。现线程池扩至 64，SSE 并发上限 48，超限时前端自动降级为
  低频轮询
- **`chat-img` 目录只接收图片**：避免它变成"传得进去、列表里看不见"的隐蔽文件通道

### 修复

- **聊天图片全部 404**：上传写入的是 `share/chat-img/`，读取却指向 exe 同目录的 `chat-img/`，
  两处路径不一致。现已统一，并在启动时**自动迁移**旧版本遗留的图片（迁移完成后原目录会被
  删除）
- **`tools/embed.ps1` 的 `-Input` 参数失效**：`$Input` 是 PowerShell 的自动变量（承载管道
  输入），一旦脚本出现在管道中就会被覆盖，导致传入的值被静默忽略、脚本悄悄回退到默认文件。
  参数已更名为 `-Source`（保留 `-Input` 作为别名）
- **`apple-touch-icon` 指向 `.ico`**：iOS 的该图标要求 PNG，原先的写法无效，已移除

### 安全

- 在线预览增加**魔数嗅探**：不再只信扩展名，会读取文件头确认真实内容，防止把改名伪装的
  非图片文件当图片渲染
- 预览与聊天图片响应增加 `X-Content-Type-Options: nosniff`
- 预览白名单**刻意不含 `.svg`**：SVG 是可内嵌 `<script>` / `<foreignObject>` 的 XML，以文档
  方式打开会执行脚本，在上传默认开放的前提下等于把"图片预览"变成存储型 XSS 的载体

### 移除

- 系统信息面板中的编译器版本展示（原本标签写死为「Node.js」、值却是 `C++/MSVC <版本>`，
  属于 Node 版移植时遗留的显示错配）

### 附件

- `LanBridge.exe` — Windows x64 单文件可执行（约 1.5MB，静态运行库，内置应用图标）

---

## 历史版本

| 版本 | 说明 |
|---|---|
| [v2.0.0](https://github.com/tanhx-boy/LanBridge/releases/tag/v2.0.0) | 从 Node.js 重写为 C++，单文件约 1MB，功能对齐 Node 版 |
| [v1.2.0](https://github.com/tanhx-boy/LanBridge/releases/tag/v1.2.0) | 最后一个 Node 版本（已归档）。新增文件删除、上传进度、拖拽上传 |
| [v1.1.0](https://github.com/tanhx-boy/LanBridge/releases/tag/v1.1.0) | 删除共享剪贴板，权限开关从 7 项减少到 6 项 |
| [v1.0.0](https://github.com/tanhx-boy/LanBridge/releases/tag/v1.0.0) | 首次公开版本 |
