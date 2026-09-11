# LanBridge (C++)

一款**轻便的、基于浏览器**的局域网工具，用于局域网内的**文件与文字共享**，同时提供**网速测试**功能。使用 C++ 实现，编译为 Windows x64 单文件 `LanBridge.exe`（约 1.5MB，无需 Node 运行时）。

> MIT License · 仅发布 x64 Windows 预编译产物

> ⚠️ **AI 生成声明**：本项目的全部代码与文档由作者与 AI 协作完成，使用 [opencode](https://github.com/sst/opencode) + [openrouter](https://openrouter.ai/) 的免费 API。代码已通过构建与功能测试，但**不保证完全无 bug**，使用前请自行评估与审查。

> 📌 本项目的前身为 Node.js 版 LanBridge（`v1.2.0` 为最后一个 Node 版本，已归档不再维护），自 `v2.0.0` 起为 C++ 版。

---

## 功能

- 📁 **文件下载** — 共享目录递归扫描（最深 3 层）+ Range 断点续传 + 中文文件名
- 📤 **文件上传** — 多选 / 整文件夹 / **拖拽上传**，流式落盘，单文件 ≤ 10GB + **单文件/总体进度**
- 🗑 **文件删除** — 仅**上传者本人**或 **localhost** 可删除文件
- 🔄 **实时同步** — 上传后通过 SSE 即时同步到其他浏览器（5 秒轮询兜底）
- 👁 **在线预览** — **仅图片**（png / jpg / jpeg / gif / webp / bmp / ico）内联打开，且校验文件真实内容；其余类型一律下载到本机后再打开
- #️⃣ **SHA-256** — 系统 BCrypt 流式计算 + 结果缓存
- 🚀 **网速测试** — 下载测速（无限随机流）、上传测速（≤500MB）、本机/外网延迟
- 💬 **实时聊天** — SSE 推送、昵称去重 `#N`、图片消息（≤9 张，**点击可放大预览**）、**实时在线人数**
- 🖥 **localhost 免昵称** — 本机访问固定显示为 `localhost`，无需填写访客名
- 🛡 **本机管理** — 仅 localhost 可见的 6 项功能权限开关，SSE 广播
- 🖼 **自定义图标** — `app.ico` 同时作为 exe 应用图标与网页标签页图标（favicon 自动裁出小尺寸）
- 🌓 深色模式、拖拽上传等前端能力

端口 **24496**，监听 `0.0.0.0`。

---

## 快速开始

1. 从 [Releases](../../releases) 下载 `LanBridge.exe`
2. 双击运行，控制台会列出可用地址
3. 浏览器打开 `http://localhost:24496`

同网段设备用控制台里 `LAN:` 开头的那条地址访问。把要共享的文件放进 exe 同目录的 `share/` 即可，无需额外配置。

---

## 依赖

| 用途 | 方案 | 说明 |
|---|---|---|
| HTTP 服务端 | [cpp-httplib](https://github.com/yhirose/cpp-httplib) v0.54.1 | `third_party/httplib.h`（MIT，单头文件） |
| JSON | [nlohmann/json](https://github.com/nlohmann/json) | `third_party/json.hpp`（MIT，单头文件） |
| SHA-256 / 随机数 | Windows BCrypt | 系统库 `bcrypt.lib`，无额外依赖 |
| 网络接口枚举 | Windows IP Helper | 系统库 `iphlpapi.lib` |
| 编译器 | MSVC（VS 2022/2026，需「使用 C++ 的桌面开发」） | `cl.exe` + `rc.exe` |

---

## 构建

```cmd
build.bat
```

`build.bat` 只是一个薄包装，真正的构建逻辑在 `tools/build.ps1`：

```
定位 Visual Studio (vswhere)
  → 定位 MSVC 工具集与 Windows SDK 版本，设置 PATH / INCLUDE / LIB
  → tools/make-favicon.ps1   app.ico → favicon.ico
  → tools/embed.ps1          index.html → src/index_html.h
  → tools/embed.ps1          favicon.ico → src/app_ico.h
  → rc                       app.rc → app.res
  → cl                       src/server.cpp + app.res → LanBridge.exe
```

产物：`LanBridge.exe`（静态运行库 `/MT`，无需 VC 运行时 DLL，内置应用图标）。

> 修改了 `index.html` 后重新运行 `build.bat` 即可生效。

### 为什么不用 vcvars64.bat

传统做法是 `call vcvars64.bat` 来准备编译环境。但这条链
（`vcvars64 → vcvarsall → VsDevCmd.bat`）会用 **`reg.exe` 查询注册表**来定位 VS 与
Windows SDK 的布局。在启用了程序黑名单、或运行于受限沙箱的机器上，`reg.exe` 可能被
拦截，此时 vcvars 会**中途失败：既不设置 INCLUDE/LIB，也不返回明确的错误码**，表现为
构建在毫无提示的情况下直接中断。

因此 `tools/build.ps1` 改为自己定位 MSVC 与 SDK 目录并直接设置 `PATH` / `INCLUDE` /
`LIB`。对本项目需要的 `cl` / `rc` / `link` 而言完全等价，而且更快，失败时会明确报出
是哪一步、哪个路径找不到。

### 手动编译（等效命令）

```powershell
# 1. 准备资源头文件
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-favicon.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\embed.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\embed.ps1 -Source favicon.ico -Output src\app_ico.h -Symbol APP_ICON
```

```cmd
rem 2. 在「x64 Native Tools Command Prompt for VS」中编译（该环境已配好 PATH/INCLUDE/LIB）
rc /nologo /fo app.res app.rc
cl /nologo /std:c++17 /O2 /MT /utf-8 /EHsc /W3 /I third_party src\server.cpp ^
   app.res /Fe:LanBridge.exe /link ws2_32.lib bcrypt.lib iphlpapi.lib
```

### 图标

| 文件 | 说明 |
|---|---|
| `app.ico` | **唯一的图标源文件**，含 16/24/32/48/64/72/96/128/256 共 9 种尺寸（422KB） |
| `app.rc` | 资源脚本，把 `app.ico` 以资源 id 1 编进 exe（Windows 取编号最小的图标作应用图标） |
| `favicon.ico` | 构建时由 `tools/make-favicon.ps1` 从 `app.ico` 裁出的 16/24/32/48 子集（约 17KB） |
| `src/app_ico.h` | 构建时生成，`favicon.ico` 的字节数组，由 `/favicon.ico` 路由提供给浏览器 |

**为什么要拆成两份**：`app.ico` 有 422KB（256×256 那层单独占约 264KB）。若直接拿它当
favicon，网页每次要多传 422KB，而且同一份数据还会在 exe 里重复存一份。裁掉大尺寸后
favicon 只有 17KB，并享有长缓存（`max-age=604800`）。裁切只做字节层面的目录重建，
不重新编码图像，画质无损。

**换图标**：只需替换 `app.ico`，重新运行 `build.bat` —— 会自动裁出新的 `favicon.ico`。
若只想调整网页图标保留哪些尺寸：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-favicon.ps1 -Sizes 16,32
```

> 换过图标后，建议把 `index.html` 里 `favicon.ico?v=` 后面的数字加一，强制浏览器重新拉取。

---

## 运行

双击 `LanBridge.exe`（或命令行运行）。首次启动会在 exe 同目录创建：

```
share/            共享文件目录（放要共享的文件）
share/chat-img/   聊天图片目录（自动创建，不出现在文件列表中）
error.log         未捕获异常日志（崩溃排查用）
```

> 旧版本（v2.0.x 及更早）的聊天图片存在 exe 同目录的 `chat-img/`，
> 新版启动时会**自动迁移**到 `share/chat-img/`，迁移完成后原目录会被删除。

浏览器打开 `http://localhost:24496`；同网段设备用控制台列出的地址。

启动时控制台只列出**真正可用**的地址：物理网卡显示为 `LAN:`，虚拟网卡（VMware / VirtualBox /
Hyper-V / WSL 等）显示为 `Virtual:` 并排在最后。APIPA 地址（`169.254.x.x`，未拿到 DHCP 时的
回退地址）、未连接/已禁用的网卡不会出现在列表里；若过滤后一个地址都不剩，会回退打印全部网卡
并给出提示。

> **不要把服务暴露到公网**：默认监听 `0.0.0.0`，同网段任何人都能访问、上传、下载。

---

## HTTP 接口

所有响应均为 JSON（文件流除外），JSON 结构统一为 `{"success": bool, ...}`。

### 文件

| 方法 | 路径 | 受权限开关 | 说明 |
|---|---|---|---|
| GET | `/`、`/index.html` | — | 前端页面（内嵌于 exe） |
| GET | `/favicon.ico` | — | 站点图标（`max-age=604800`） |
| GET | `/files` | — | 共享目录树 JSON，每个文件带 `canDelete` 与 `previewable` |
| GET | `/download/<path>` | `download` | 下载，支持 Range 断点续传 |
| PUT | `/upload/<path>` | `upload` | 流式上传，单文件 ≤ 10GB |
| GET | `/preview/<path>` | `preview` | 仅图片；扩展名白名单 + 魔数嗅探双重校验 |
| GET | `/hash/<path>` | `hash` | 流式 SHA-256，按 size+mtime 缓存 |
| DELETE | `/delete/<path>` | — | 删除，需 localhost 或上传者本人的 `X-Client-Id` |

### 聊天

| 方法 | 路径 | 受权限开关 | 说明 |
|---|---|---|---|
| GET | `/chat/stream` | `chat` | SSE 长连接，并发上限 48，超限返回 503 |
| POST | `/chat/send` | `chat` | 发送消息，返回最终昵称 |
| POST | `/chat/leave` | — | 主动离线（页面 `pagehide` 时 sendBeacon 调用） |
| GET | `/chat-img/<name>` | — | 聊天图片，仅接受图片扩展名上传 |

### 测速与系统

| 方法 | 路径 | 受权限开关 | 说明 |
|---|---|---|---|
| GET | `/speedtest` | `speedtest` | 下载测速，无限随机流 |
| POST | `/upload-test` | `speedtest` | 上传测速，上限 500MB |
| GET | `/ping` | — | 本机延迟 |
| GET | `/ping-external?host=` | — | 外网 TCP:443 握手延迟（host 经正则校验） |
| GET | `/api/info` | — | 端口、本机 IP、主机名、CPU、权限状态 |
| GET | `/api/client-info` | — | 请求方 IP / UA / 是否 localhost |
| GET | `/api/admin/status` | — | 权限状态（**仅 localhost**） |
| POST | `/api/admin/permission` | — | 切换权限开关（**仅 localhost**） |

### SSE 事件

`GET /chat/stream` 建立后会依次推送 `history` 和 `permission`，之后按需推送：

| 事件 | 数据 | 说明 |
|---|---|---|
| `history` | 消息数组 | 最近 100 条聊天记录 |
| `message` | 单条消息 | 新消息 |
| `presence` | `{count, names}` | 在线人数与昵称列表 |
| `permission` | 6 项开关状态 | 权限变更广播 |
| `files-changed` | `{path, deleted?}` | 文件增删，前端据此刷新列表 |
| `: ping` | — | 每 5 秒心跳注释帧，防代理超时 |

---

## 关键参数

| 项 | 值 |
|---|---|
| 端口 | 24496 |
| 最大上传 | 10 GB |
| 测速上传上限 | 500 MB |
| 共享目录扫描深度 | 3 层 |
| 聊天历史保留 | 100 条 |
| 单条消息长度 | 200 字符 |
| 单条消息图片数 | ≤ 9 张 |
| SSE 并发上限 | 48 |
| HTTP 线程池 | 64 |
| SHA-256 缓存条目 | 200 |

---

## 目录结构

```
.
├── src/
│   ├── server.cpp          # 主程序（全部服务端逻辑）
│   ├── index_html.h        # 构建时生成（不提交）
│   └── app_ico.h           # 构建时生成（不提交）
├── third_party/
│   ├── httplib.h
│   └── json.hpp
├── tools/
│   ├── build.ps1           # 构建主逻辑（build.bat 调用它）
│   ├── embed.ps1           # 任意文件 → C++ 字节数组头
│   └── make-favicon.ps1    # app.ico → favicon.ico（裁掉大尺寸）
├── index.html              # 前端页面（构建时嵌入 exe）
├── app.ico                 # 图标源文件（9 种尺寸）
├── app.rc                  # 图标资源脚本
├── favicon.ico             # 构建时生成（不提交）
├── build.bat
├── .gitignore
├── LICENSE
└── README.md
```

---

## 安全说明

- **无鉴权**：服务不设账号密码，**任何能访问到该端口的人都能浏览、上传、下载**。这是为
  局域网内快速传文件做的取舍，请勿将其暴露到公网。
- **删除权限**：仅 localhost 或持有相同 `X-Client-Id` 的上传者可删。`X-Client-Id` 由客户端
  自行生成并保存在浏览器本地，**不是强认证**——同网段知道该 ID 的人可以伪造。上传者记录仅存
  内存，服务重启后只有 localhost 能删。
- **路径防护**：所有带路径的接口都经过三道校验 —— 剔除 `..` 段、词法层校验目标是否位于共享
  目录内、再解析软链接复查一次，防止目录穿越与符号链接逃逸。
- **在线预览只允许图片**：白名单之外的类型一律走下载。之所以不含 `.svg`，是因为 SVG 是能内嵌
  `<script>` 的 XML，以文档方式打开会执行脚本，在"上传默认开放"的前提下等于存储型 XSS 载体。
  预览还会做魔数嗅探并返回 `X-Content-Type-Options: nosniff`，防止把改名伪装的非图片文件
  当图片渲染。
- **本机管理**：`/api/admin/*` 只对 `127.0.0.1` 开放，用于开关上述 6 项功能。

---

## 常见问题

**启动提示端口 24496 被占用**
换一台设备或结束占用进程。查询占用：`netstat -ano | findstr :24496`。

**局域网其他设备打不开**
先确认它们连的是同一网段（对照控制台 `LAN:` 的地址）。仍不通通常是 Windows 防火墙拦了，
放行端口 24496 即可。若本机跑在虚拟机里，VMware 网络需为**桥接模式**。

**浏览器标签页还是默认地球图标**
说明浏览器没重新请求过 favicon —— Chrome / Edge **只在页面加载时**请求它，重启服务端不会触发。
请**关闭该标签页后重新打开**（按 F5 不一定够），或在浏览器设置里清除「缓存的图像和文件」。
若刚换过图标，把 `index.html` 里 `favicon.ico?v=` 的数字加一。

**改了 `index.html` 但页面没变**
`index.html` 是被嵌进 exe 的，必须重新运行 `build.bat` 再启动 exe。另外页面带
`Cache-Control: no-store`，但浏览器仍可能缓存图片等子资源。

**能共享多大的文件**
单文件上限 10GB，走流式落盘，不会把整个文件读进内存。

**能在 Linux / macOS 上运行吗**
不能。代码直接依赖 Win32 API（Winsock / BCrypt / IP Helper），没有做跨平台抽象层。
曾有通过 Wine 运行 Windows 产物的设想，但那样要求用户先装数百 MB 的兼容层，与
「单文件、免运行时」的定位相悖，故未采用。

---

## 与旧 Node 版的差异

- 体积从约 100MB 降到约 1.5MB，无需 Node 运行时
- Range 解析、416 等由 cpp-httplib 处理，行为与 Node 版基本一致
- 上传者记录仅存内存，服务重启后仅 localhost 可删除（按设计）
- 在线预览由 Node 版的多类型（txt / md / json / pdf 等）收窄为**仅图片**，并增加内容魔数校验
- 聊天图片目录由 `chat-img/` 改为 `share/chat-img/`，修复上传与读取路径不一致导致的图片 404
- 新增 SSE 并发上限与失败退避，避免长连接占满线程池拖垮文件传输
- 新增应用图标与网页图标；控制台 IP 列表会过滤 APIPA 与未连接网卡
- 无自动化测试，采用人工冒烟验证

---

## 更新日志

各版本的功能变更见 [CHANGELOG.md](CHANGELOG.md)，完整版本说明见 [Releases](../../releases)。

---

## 许可证

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。`third_party/` 下的头文件遵循其各自许可证（均为 MIT）。
