# LanBridge (C++)

一款**轻便的、基于浏览器**的局域网工具，用于局域网内的**文件与文字共享**，同时提供**网速测试**功能。使用 C++ 实现，编译为 Windows x64 单文件 `LanBridge.exe`（约 1MB，无需 Node 运行时）。

> MIT License · 仅发布 x64 Windows 预编译产物

> ⚠️ **AI 生成声明**：本项目的全部代码与文档由作者与 AI 协作完成，使用 [opencode](https://github.com/sst/opencode) + [openrouter](https://openrouter.ai/) 的免费 API。代码已通过构建与功能测试，但**不保证完全无 bug**，使用前请自行评估与审查。

> 📌 本项目的前身为 Node.js 版 LanBridge（`v1.2.0` 为最后一个 Node 版本，已归档不再维护），自 `v2.0.0` 起为 C++ 版。

---

## 功能

- 📁 **文件下载** — 共享目录递归扫描（最深 3 层）+ Range 断点续传 + 中文文件名
- 📤 **文件上传** — 多选 / 整文件夹 / **拖拽上传**，流式落盘，单文件 ≤ 10GB + **单文件/总体进度**
- 🗑 **文件删除** — 仅**上传者本人**或 **localhost** 可删除自己上传的文件
- 🔄 **实时同步** — 上传后通过 SSE 即时同步到其他浏览器（5 秒轮询兜底）
- 👁 **在线预览** — txt / md / json / log / csv / ini / 图片 / pdf 内联打开
- #️⃣ **SHA-256** — 系统 BCrypt 流式计算 + 结果缓存
- 🚀 **网速测试** — 下载测速（无限随机流）、上传测速（≤500MB）、本机/外网延迟
- 💬 **实时聊天** — SSE 推送、昵称去重 `#N`、图片消息（≤9 张）、**实时在线人数**
- 🖥 **localhost 免昵称** — 本机访问固定显示为 `localhost`，无需填写访客名
- 🛡 **本机管理** — 仅 localhost 可见的 6 项功能权限开关，SSE 广播
- 🌓 深色模式、拖拽上传等前端能力

端口 **24496**，监听 `0.0.0.0`。

---

## 依赖

| 用途 | 方案 | 说明 |
|---|---|---|
| HTTP 服务端 | [cpp-httplib](https://github.com/yhirose/cpp-httplib) v0.54.1 | `third_party/httplib.h`（MIT，单头文件） |
| JSON | [nlohmann/json](https://github.com/nlohmann/json) | `third_party/json.hpp`（MIT，单头文件） |
| SHA-256 / 随机数 | Windows BCrypt | 系统库 `bcrypt.lib`，无额外依赖 |
| 编译器 | MSVC（VS 2022/2026，需「使用 C++ 的桌面开发」） | `cl.exe` |

---

## 构建

```cmd
build.bat
```

流程：定位 Visual Studio → `vcvars64` → 用 `tools/embed.ps1` 把 `index.html` 转成 `src/index_html.h` → `cl` 编译。

产物：`LanBridge.exe`（静态运行库 `/MT`，无需 VC 运行时 DLL）。

> 修改了 `index.html` 后重新运行 `build.bat` 即可生效。

### 手动编译（等效命令）

```cmd
call "<VS>\VC\Auxiliary\Build\vcvars64.bat"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\embed.ps1
cl /nologo /std:c++17 /O2 /MT /utf-8 /EHsc /W3 /I third_party src\server.cpp ^
   /Fe:LanBridge.exe /link ws2_32.lib bcrypt.lib iphlpapi.lib
```

---

## 运行

双击 `LanBridge.exe`（或命令行运行）。首次启动会在 exe 同目录创建：

```
share/      共享文件目录（放要共享的文件）
chat-img/   聊天图片目录
error.log   未捕获异常日志（崩溃排查用）
```

浏览器打开 `http://localhost:24496`；同网段设备用 `http://<本机局域网IP>:24496`。

> **不要把服务暴露到公网**：默认监听 `0.0.0.0`，同网段任何人都能访问、上传、下载。

---

## 目录结构

```
.
├── src/server.cpp          # 主程序
├── src/index_html.h        # 构建时生成（不提交）
├── third_party/
│   ├── httplib.h
│   └── json.hpp
├── tools/embed.ps1         # index.html → index_html.h
├── index.html              # 前端页面（构建时嵌入 exe）
├── build.bat
├── LICENSE
└── README.md
```

---

## 与旧 Node 版的差异

- 体积从 ~100MB 降到 ~1MB，无需 Node 运行时
- `/api/info` 的 `nodeVersion` 字段填入编译器版本（如 `C++/MSVC 1951`），前端标签仍显示「Node.js」（前端未改动）
- Range 解析、416 等由 cpp-httplib 处理，行为与 Node 版基本一致
- 上传者记录仅存内存，服务重启后仅 localhost 可删除（按设计）
- 无自动化测试，采用人工冒烟验证

---

## 许可证

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。`third_party/` 下的头文件遵循其各自许可证（均为 MIT）。
