[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/tanhx-boy/LanBridge)](https://github.com/tanhx-boy/LanBridge/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue)](https://github.com/tanhx-boy/LanBridge/releases)

> ⚠️ **AI 生成声明**：本项目的全部代码与文档由作者与 AI 协作完成，使用 [opencode](https://github.com/sst/opencode) Desktop + [openrouter](https://openrouter.ai/) 的免费 API。代码已通过构建与功能测试，但**不保证完全无 bug**，使用前请自行评估与审查。

# LanBridge

一款**轻便的、基于浏览器**的局域网工具，用于局域网内的**文件与文字共享**，同时提供一个**测速**功能。基于 Node.js 内置模块运行，可打包成单个 `webshare.exe` 在无 Node 环境的 Windows x64 上运行。

> MIT License · 跨平台源码 · 仅发布 x64 Windows 预编译产物

---

## 项目简介

LanBridge 是一款**轻便的、基于浏览器**的局域网工具，用于局域网内的**文件与文字共享**，同时提供**网速测试**功能。典型场景：

- 主机跑服务，VM / 手机 / 同事电脑浏览器打开就能用
- 临时分享文件、聊天，不想搭 FTP / 装 IM
- 测内网带宽、调试 HTTP 上传下载
- 局域网内多人协作时共享一份"活动板"

特点：**零第三方依赖**（纯 Node 内置模块）、**单文件可执行**（Node SEA 打包）、**开箱即用**（双击即跑）。

---

## 特性

- **📁 文件浏览 / 下载** — 共享目录递归扫描（最深 3 层），支持中文文件名 + Range 断点续传
- **📤 文件上传** — 多选 / 整文件夹拖入，单文件 ≤ 10GB，流式上传
- **👁 在线预览** — txt / md / json / log / csv / ini / 图片 / pdf 内联打开
- **#️⃣ SHA-256 校验** — 前端计算并复制哈希，校验下载完整性
- **🚀 网速测试** — 延迟、下载测速（5/10/30s）、上传测速，实时曲线图
- **💬 实时聊天** — SSE 推送，Apple 风格气泡，图片消息
- **🌓 深色模式** — 自动跟随系统 / 手动切换 / localStorage 记忆
- **🛡 本机管理** — localhost 限定的功能权限开关，6 项可独立启停
- **📦 单文件 EXE** — Node SEA 打包，目标机无需 Node

---

## 快速开始

### 方式一：使用预编译 EXE（推荐普通用户）

1. 在 [Releases](https://github.com/tanhx-boy/LanBridge/releases) 下载 `webshare.exe`
2. 双击运行（首次 Windows Defender / 防火墙会弹窗，全部放行）
3. 浏览器打开 `http://localhost:24496`
4. 想给同网段其他人用：把 `http://<你的局域网IP>:24496` 发给他们

> **不要直接双击终端里的 URL**。终端里的链接点击可能触发窗口关闭——请在浏览器地址栏手输，或右键终端 → 标记 → 拖选 → Enter 复制。

### 方式二：从源码运行（开发者 / 贡献者）

需要 Node.js 18+（构建 EXE 需要 26.7.0+）。

```bash
git clone <repo-url>
cd LanBridge
node server.js
```

或 Windows 下双击 `start.bat` / Linux 下 `./start.sh`。

无需 `npm install`、无需任何第三方包。

---

## 自定义配置

所有可调参数都在 `server.js` 顶部，**改完保存即生效**（dev 模式；EXE 模式需重新构建）。

### 修改端口

```js
// server.js 第 88-89 行
const PORT = 24496           // 改成任意未被占用的端口，如 8080、3000
const HOST = '0.0.0.0'       // 0.0.0.0 = 监听所有网卡；127.0.0.1 = 仅本机
```

> 换端口后**同步更新防火墙规则**（放行新端口的入站 TCP），并把 README/链接里的 `24496` 一并改掉。

### 修改共享目录名

```js
// server.js 第 53-54 行
const SHARE_DIR = path.join(PROGRAM_DIR, 'share')     // 改成 'public' / 'files' 等
const CHAT_IMG_DIR = path.join(PROGRAM_DIR, 'chat-img') // 聊天图片目录
```

> 同时改两处对应的字符串字面量。`share` 在 `scanTree` 过滤逻辑（line 188）和 SELF_FILES（line 92）里也有出现。

### 修改聊天限制

```js
// server.js 第 97-98 行
const CHAT_HISTORY_MAX = 100   // 服务器保留的最近聊天条数（超过会丢弃最旧）
const CHAT_MSG_MAX = 200       // 单条消息最大字符数
```

### 隐藏特定文件不出现在下载列表

```js
// server.js 第 92 行
const SELF_FILES = new Set([
  'server.js', 'index.html', 'README.md',
  'sea-config.json', 'build.bat', 'package.json',
  // 往下追加你不想被共享的文件名，如：
  // 'package-lock.json',
  // 'LICENSE',
  // '.gitignore',
])
```

---

## 详细功能

### 文件下载

把文件**放进 `share/` 文件夹**（或子目录，最深 3 层），刷新页面即自动列出。`server.js`、`index.html`、`README.md`、`chat-img/` 和 `.` 开头的隐藏文件不会列出。每个文件支持：

- **下载**（中文文件名 + 大文件流式 + Range 断点续传，附件形式不会在浏览器打开）
- **SHA256 哈希**：点击"哈希"按钮计算并自动复制
- **在线预览**：`/preview/<filename>` 路径，txt / md / json / log / csv / ini / 图片（png/jpg/gif/webp/svg/bmp/ico）/ pdf 直接内联打开，其余类型返回 415

### 文件上传

页面上传区支持多选文件或**整个文件夹**（含子目录结构），逐文件流式上传（**单文件 ≤ 10GB**），带整体进度条，完成后下载区自动刷新。上传路径经严格校验（拒绝 `..` 穿越与服务自身文件），失败自动清理半成品。

### 网速测试

- **延迟测试**：本机延迟（HTTP RTT）、外网延迟（TCP 握手），支持自定义域名
- **下载测速**：服务端无限流生成随机数据，客户端按设定时长（5/10/30 秒）持续读取，实时显示速率 + 速度曲线图 + 流量统计
- **上传测速**：客户端循环上传 4MB 随机块直至跑满时长，同样有曲线图和流量统计

### 实时聊天

- **昵称区分**：首次发言时输入昵称（仅本次会话有效，关闭标签即清除），同名用户自动加 `#N` 后缀
- **Apple 风格气泡**：自己蓝色气泡右对齐、他人白色气泡左对齐，每人首字圆形头像（颜色按昵称哈希）
- **图片消息**：支持 JPG/PNG/HEIF/HEIC 等常见格式，最多 9 张同发，单张 ≤ 20MB
- **图片复制**：每张图有独立复制按钮（需 HTTPS 或 localhost 才可复制，HTTP 下提示另存为）
- **在线状态**：实时显示在线人数
- **聊天图片**：自动存入 `chat-img/` 目录，**不自动清空**（跨重启保留）

### 系统信息

页面顶部卡片自动展示：

- 局域网 IPv4 / 端口 / 主机名 / 操作系统 / Node.js 版本
- 当前页面访问地址 + 客户端 IP + 浏览器 User-Agent

### 深色模式

页面右上角提供主题切换按钮（☀/☾）：

- **自动检测**：默认跟随系统深色/浅色模式（`prefers-color-scheme`）
- **手动切换**：点击按钮切换，选择保存到 `localStorage`，下次打开自动恢复
- **系统监听**：未手动选择时，切换系统主题会自动跟随

### 本机管理

通过 `http://localhost:24496` 访问时，页面额外显示"本机管理"卡片：

- 6 个功能权限开关，**立即生效** + **SSE 广播**给所有客户端：
  - 文件下载 / 文件上传 / 在线预览 / SHA-256 / 局域网聊天 / 网速测试
- 仅 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 请求能调管理 API，VM 访问看不到也调不到
- 无需任何认证：本地浏览器打开即用，关闭页面无副作用
- 权限校验在**服务端**完成，不依赖前端隐藏按钮

---

## 虚拟机访问

1. 本机运行 `node server.js` 或 `webshare.exe`，记下控制台打印的局域网地址，例如 `http://192.168.1.100:24496`
2. 虚拟机浏览器（不限系统/浏览器）打开该地址

### 两个前提（打不开时检查）

| 现象 | 解决办法 |
| --- | --- |
| 虚拟机打不开、转圈超时 | ① VM 网络必须是**桥接模式**（NAT 模式访问不到宿主机）② Windows 防火墙首次会拦截，放行 node.exe 或入站 TCP 24496 端口（`netsh advfirewall firewall add rule name="LanBridge" dir=in action=allow protocol=TCP localport=24496`） |
| 页面能开但复制没反应 | 这是浏览器限制（HTTP 非安全上下文），换用页面上的"复制"按钮（已做兼容处理）；若仍失败请手动全选复制 |

---

## 平台兼容性

本仓库**只发布并测试 x64 Windows** 平台的预编译 EXE。但项目代码本身跨平台：

| 平台 | 预编译 EXE | 从源码运行 | 说明 |
|---|---|---|---|
| **x64 Windows** | ✅ 提供 | ✅ `node server.js` | 主要测试平台 |
| ARM64 Windows | ❌ 未提供 | ✅ `node server.js` | 需用户自行 `node --build-sea` 构建 |
| x64 Linux | ❌ 未提供 | ✅ `node server.js` | 自行构建 |
| ARM64 Linux | ❌ 未提供 | ✅ `node server.js` | 树莓派等 |
| macOS (Intel / Apple Silicon) | ❌ 未提供 | ✅ `node server.js` | 自行构建 |

任何装了 Node.js 18+ 的系统都能从源码运行。SEA 工具链 (`node --build-sea`) 在所有 Node.js 26+ 平台都可用。

> 在其他平台跑遇到问题，欢迎提 Issue，但维护者优先保证 x64 Windows 的兼容性。

---

## SEA 打包（单文件 EXE）

将 `server.js + index.html` 打成单个 `webshare.exe`，目标机器无需安装 Node.js。

### 构建

```cmd
build.bat
```

要求：当前机器已安装 Node.js v26.7.0+（`node --build-sea` 内置命令）。`node --version` 验证。

成功后产物：

```text
webshare.exe        （约 90-100 MB，含 Node 运行时 + index.html）
sea-prep.blob       （已自动删除）
```

### 运行

直接双击 `webshare.exe`，或在 cmd 里 `webshare.exe` 运行（后者窗口不闪退、便于看 banner）。

启动后：

- 在 EXE **同目录**自动创建 `share/` 和 `chat-img/`（首次启动）
- 所有文件操作基于 `share/`（不再以 EXE 所在目录为共享根）
- 终端窗口保留运行，显示 banner + 局域网地址 + 共享目录路径

最终目录结构：

```text
webshare.exe
share/
  ... 共享文件
chat-img/
  ... 聊天图片（不自动清空，跨重启保留）
error.log           （未捕获异常会写入这里）
```

### 体积说明

约 90-100 MB 是 **Node.js 完整运行时**（V8 + libuv + ICU + 内置模块）的大小，无法进一步压缩。Node 官方未提供"裁剪"工具。可接受第三方工具（如 UPX 压缩 EXE），但会触发 Windows Defender 误报——不推荐。

### 跨平台构建

在目标平台跑 `build.bat`（或对应的 `.sh`）即可产出该平台的 SEA EXE。`sea-config.json` 不需要改。

---

## 安全与限制

### 适用场景

本项目设计用于**可信局域网**（家庭、公司内网、开发团队内部），**不适合部署到公网**。

### 已实施的安全措施

- **本机管理面板**仅 localhost (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`) 可见可调，VM/局域网设备看不到也调不到
- **路径穿越防护**：`/download/` 与 `/upload/` 拒绝 `..` 穿越
- **symlink 逃逸防护**：通过 `realpath` 校验，`share/` 内的 symlink 不能指向 `share/` 外的文件
- **自身文件保护**：`server.js` 等 SELF_FILES 不出现在下载列表，不能被覆盖
- **文件大小限制**：单上传 ≤ 10GB，单聊天图片 ≤ 20MB
- **聊天图片路径限制**：仅接受 `/chat-img/` 前缀
- **CORS 不开放**：无 `Access-Control-Allow-Origin` 头，浏览器同源策略生效

### 不要做的事

- ❌ **不要将本程序暴露到公网**：默认监听 `0.0.0.0:24496`，路由器端口转发后任何人都能上传/下载你电脑的文件、读你的聊天记录
- ❌ **不要在不可信网络（公共 WiFi、咖啡馆）上运行**：同网段任何人都能访问
- ❌ **不要全量放行 node.exe 的防火墙规则**：只放行 24496 端口即可
- ❌ **不要把 `share/` 目录指向系统敏感目录**（如 `C:\`、家目录）：上传/下载完全开放
- ❌ **不要用于传输机密信息**：本项目无加密、无审计、无认证

### 已知局限

- 聊天记录仅内存保存，进程退出即丢失
- 任何用户都能上传文件到 share/（无登录、无配额）
- 无速率限制（局域网内通常不需要）
- 未实现访问日志（无审计）

---

## 开发

### 仓库结构

```text
.
├── server.js           # Node 服务端（约 750 行，单文件，零依赖）
├── index.html          # 浏览器前端（HTML + CSS + JS，单文件）
├── sea-config.json     # SEA 打包配置
├── build.bat           # Windows SEA 构建脚本
├── start.bat           # Windows 启动脚本
├── start.sh            # Linux / macOS 启动脚本
├── LICENSE             # MIT 许可证
├── README.md           # 本文件
├── .gitignore          # Git 忽略规则（排除 build 产物、运行时数据等）
├── share/              # 共享文件根目录（运行时自动创建）
└── chat-img/           # 聊天图片目录（运行时自动创建）
```

### 调试日志

- SEA 模式启动时会在 EXE 同目录写 `error.log`，记录未捕获异常
- 开发模式（`node server.js`）下所有错误直接在控制台打印
- 端口被占用、文件不存在等场景均有友好提示

### 代码风格

- 服务端：CommonJS、单文件、无构建步骤
- 前端：单 HTML 文件 + 内联 CSS / JS，**无构建工具链**
- 注释用中文，变量 / 函数名用英文

---

## 常见问题

**使用篇**

- **改完内容 VM 里没变化**：浏览器缓存。按 Ctrl+F5 强制刷新（服务端已设 `Cache-Control: no-store`，一般不缓存）
- **本机能开、VM 开不了**：见上表前提检查网络模式与防火墙
- **换端口**：编辑 `server.js` 第 88 行的 `PORT` 变量，同步更新防火墙规则
- **端口被占用**：启动时会给出友好提示与查询命令（`netstat -ano | findstr :24496`）
- **下载测速时间不够长**：服务端无限流生成数据，可按设定时长（5/10/30 秒）完整运行
- **VM 能否调管理 API**：不能，仅 localhost 来源通过；非 localhost 一律 403
- **聊天图片能清空吗**：手动删除 `chat-img/` 目录里的文件即可，**不自动清理**

**打包篇**

- **`--build-sea` 命令找不到**：需要 Node.js v26.7.0+。`node --version` 检查
- **EXE 启动报"找不到入口"**：`sea-config.json` 路径错误，确认在项目根目录运行 `build.bat`
- **EXE 启动后页面 500**：检查 `sea-config.json` 中 `assets.index.html` 路径是否正确（应为 `index.html`，与文件相对）
- **Windows Defender 拦截新 EXE**：首次运行可能触发云端扫描，等待几分钟后放行或添加信任；无数字签名是预期行为（开源项目通常不自签）
- **EXE 体积过大（~100MB）**：Node SEA 内置完整 Node 运行时，无法压缩
- **点终端里 URL 后窗口关闭**：不要在终端里点 URL。已在 banner 提示；程序启动时执行 `mode con /quickedit off` 减少误触。在浏览器地址栏手输或右键复制 URL 即可
- **EXE 闪退看不到错误**：未捕获异常写入 EXE 同目录的 `error.log`，用文本编辑器打开即可看到完整堆栈。也可用 cmd 启动 EXE 而不是双击，窗口不自动关

---

## 许可证

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。

简单来说：你可自由使用、修改、分发本项目的代码（包括商用），只需在所有副本中保留版权声明和许可证声明。软件按"原样"提供，作者不承担任何责任。

> 本节为非法律性简介，正式条款以 [LICENSE](LICENSE) 文件全文为准。

---

## 致谢

- 本项目代码由作者与 AI 协作完成，使用 [opencode](https://github.com/sst/opencode) CLI + [openrouter](https://openrouter.ai/) 的免费 API
- [Node.js](https://nodejs.org/) — 提供运行时 + SEA 单文件打包能力
- 所有贡献者
