// ============================================================================
// LanBridge C++ 版服务端
// 对标 web-copy-share/server.js，功能对齐：
//   文件下载/上传/预览/哈希、测速、SSE 聊天、系统信息、本机管理
// 依赖：cpp-httplib（HTTP）、nlohmann/json（JSON）、Windows BCrypt（SHA-256/随机数）
// 构建：见 build.bat（MSVC，静态运行库，单文件 exe）
// ============================================================================

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef CPPHTTPLIB_THREAD_POOL_COUNT
#define CPPHTTPLIB_THREAD_POOL_COUNT 16
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "httplib.h"
#include "json.hpp"
#include "index_html.h"

using json = nlohmann::json;
namespace fs = std::filesystem;

// ============ 常量 ============
static const int PORT = 24496;
static const char *HOST = "0.0.0.0";
static const size_t CHAT_HISTORY_MAX = 100;
static const size_t CHAT_MSG_MAX = 200;
static const unsigned long long UPLOAD_MAX = 10ULL * 1024 * 1024 * 1024;   // 10GB
static const unsigned long long UPLOAD_TEST_MAX = 500ULL * 1024 * 1024;    // 500MB
static const size_t HASH_CACHE_MAX = 200;

// 自身文件：不出现在下载列表，也不可被下载/覆盖
static const std::set<std::string> SELF_FILES = {
    "server.cpp", "LanBridge.exe", "index.html", "index_html.h", "README.md",
    "build.bat", "embed.ps1", "httplib.h", "json.hpp"};

// 在线预览支持的扩展名
static const std::unordered_map<std::string, std::string> PREVIEW_TYPES = {
    {".txt", "text/plain"},   {".md", "text/markdown"}, {".json", "application/json"},
    {".log", "text/plain"},   {".csv", "text/plain"},   {".ini", "text/plain"},
    {".png", "image/png"},    {".jpg", "image/jpeg"},   {".jpeg", "image/jpeg"},
    {".gif", "image/gif"},    {".webp", "image/webp"},  {".svg", "image/svg+xml"},
    {".bmp", "image/bmp"},    {".ico", "image/x-icon"}, {".pdf", "application/pdf"},
};

// ============ 全局路径 ============
static fs::path PROGRAM_DIR;
static fs::path SHARE_DIR;
static fs::path CHAT_IMG_DIR;
static fs::path LOG_FILE;

// ============ 权限开关 ============
struct Permissions {
  std::atomic<bool> download{true};
  std::atomic<bool> upload{true};
  std::atomic<bool> preview{true};
  std::atomic<bool> hash{true};
  std::atomic<bool> chat{true};
  std::atomic<bool> speedtest{true};
};
static Permissions perms;

// ============ 聊天状态 ============
struct ChatMessage {
  std::string id;
  long long time = 0;
  std::string name;
  std::string text;
  std::vector<std::string> images;
};

static std::deque<ChatMessage> chatHistory;
static std::mutex chatHistoryMutex;

struct ChatClient {
  std::mutex m;
  std::condition_variable cv;
  std::deque<std::string> queue;
  std::atomic<bool> alive{true};
  std::string name = "匿名";
  std::string cid;

  void enqueue(const std::string &s) {
    {
      std::lock_guard<std::mutex> lk(m);
      queue.push_back(s);
    }
    cv.notify_one();
  }
};

static std::vector<std::shared_ptr<ChatClient>> chatClients;
static std::mutex chatClientsMutex;

// 上传记录（仅内存）：relPath -> { name, cid, time }，用于删除权限判定
struct UploadMeta {
  std::string name;
  std::string cid;
  long long time = 0;
};
static std::unordered_map<std::string, UploadMeta> uploadMeta;
static std::mutex uploadMetaMutex;

// ============ 哈希缓存 ============
struct HashEntry {
  std::string hash;
  unsigned long long size = 0;
  long long mtime = 0;
};
static std::unordered_map<std::string, HashEntry> hashCache;
static std::mutex hashCacheMutex;

static httplib::Server *g_server = nullptr;
static std::atomic<bool> g_running{true};

// ============================================================================
// 基础工具
// ============================================================================

static std::string w_to_u8(const std::wstring &w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::wstring u8_to_w(const std::string &s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

static std::string to_lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

static std::string trim(const std::string &s) {
  size_t a = 0, b = s.size();
  while (a < b && (unsigned char)s[a] <= ' ') a++;
  while (b > a && (unsigned char)s[b - 1] <= ' ') b--;
  return s.substr(a, b - a);
}

// 按 UTF-8 码点截断（避免截断多字节字符）
static std::string utf8_truncate(const std::string &s, size_t max_cp) {
  size_t cp = 0, i = 0;
  while (i < s.size() && cp < max_cp) {
    unsigned char c = (unsigned char)s[i];
    size_t len = 1;
    if (c >= 0xF0) len = 4;
    else if (c >= 0xE0) len = 3;
    else if (c >= 0xC0) len = 2;
    if (i + len > s.size()) break;
    i += len;
    cp++;
  }
  return s.substr(0, i);
}

static std::string url_decode(const std::string &s) {
  std::string out;
  out.reserve(s.size());
  auto hex = [](char h) -> int {
    if (h >= '0' && h <= '9') return h - '0';
    if (h >= 'a' && h <= 'f') return h - 'a' + 10;
    if (h >= 'A' && h <= 'F') return h - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '%' && i + 2 < s.size()) {
      int hi = hex(s[i + 1]), lo = hex(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back((char)((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    out.push_back(c);
  }
  return out;
}

// RFC 5987 编码（用于 filename*）
static std::string rfc5987(const std::string &name) {
  static const char *hexd = "0123456789ABCDEF";
  std::string out;
  out.reserve(name.size() * 3);
  for (unsigned char c : name) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '!') {
      out.push_back((char)c);
    } else {
      out.push_back('%');
      out.push_back(hexd[c >> 4]);
      out.push_back(hexd[c & 15]);
    }
  }
  return out;
}

static std::string contentDisposition(const std::string &name, bool attachment) {
  std::string ascii;
  ascii.reserve(name.size());
  for (unsigned char c : name) ascii.push_back((c >= 0x20 && c <= 0x7e) ? (char)c : '_');
  return (attachment ? "attachment" : "inline") + std::string("; filename=\"") + ascii +
         "\"; filename*=UTF-8''" + rfc5987(name);
}

static std::vector<std::string> split_path(const std::string &raw) {
  std::string s = raw;
  for (auto &c : s) if (c == '\\') c = '/';
  std::vector<std::string> segs;
  size_t start = 0;
  while (start <= s.size()) {
    size_t pos = s.find('/', start);
    std::string seg = s.substr(start, pos == std::string::npos ? std::string::npos : pos - start);
    if (!seg.empty() && seg != ".") segs.push_back(seg);
    if (pos == std::string::npos) break;
    start = pos + 1;
  }
  return segs;
}

static std::string join_path(const std::vector<std::string> &segs) {
  std::string out;
  for (size_t i = 0; i < segs.size(); ++i) {
    if (i) out.push_back('/');
    out += segs[i];
  }
  return out;
}

static bool has_dotdot(const std::vector<std::string> &segs) {
  for (auto &s : segs) if (s == "..") return true;
  return false;
}

// child 是否位于 base 之内（词法层，不解符号链接）
static bool is_under(const fs::path &base, const fs::path &child) {
  fs::path rel = child.lexically_normal().lexically_relative(base.lexically_normal());
  if (rel.empty()) return false;
  if (rel.is_absolute()) return false;
  for (auto &part : rel) if (part == "..") return false;
  return true;
}

// child 是否位于 base 之内（解析符号链接后）
static bool is_under_real(const fs::path &base, const fs::path &child) {
  std::error_code ec;
  fs::path b = fs::weakly_canonical(base, ec);
  if (ec) return false;
  fs::path c = fs::weakly_canonical(child, ec);
  if (ec) return false;
  return is_under(b, c);
}

// ============ 异常日志 ============
static void logError(const std::string &tag, const std::string &msg) {
  SYSTEMTIME st;
  GetLocalTime(&st);
  char ts[64];
  std::snprintf(ts, sizeof(ts), "%04d-%02d-%02dT%02d:%02d:%02d", st.wYear, st.wMonth,
                st.wDay, st.wHour, st.wMinute, st.wSecond);
  std::string line = "[" + std::string(ts) + "] " + tag + ": " + msg + "\r\n";
  try { std::fputs(line.c_str(), stderr); } catch (...) {}
  if (!LOG_FILE.empty()) {
    std::ofstream ofs(LOG_FILE, std::ios::app | std::ios::binary);
    if (ofs) ofs << line;
  }
}

static LONG WINAPI unhandledFilter(EXCEPTION_POINTERS *ep) {
  char buf[128];
  std::snprintf(buf, sizeof(buf), "SEH exception code=0x%08lX",
                ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionCode : 0UL);
  logError("unhandledException", buf);
  return EXCEPTION_EXECUTE_HANDLER;
}

// ============ 控制台 UTF-8 + 禁用快速编辑 ============
static void setupConsole() {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  if (h && h != INVALID_HANDLE_VALUE) {
    DWORD mode = 0;
    if (GetConsoleMode(h, &mode)) {
      mode &= ~ENABLE_QUICK_EDIT_MODE;
      mode |= ENABLE_EXTENDED_FLAGS;
      SetConsoleMode(h, mode);
    }
  }
}

// ============ 权限 JSON ============
static json permsJson() {
  return json{{"download", perms.download.load()}, {"upload", perms.upload.load()},
              {"preview", perms.preview.load()},   {"hash", perms.hash.load()},
              {"chat", perms.chat.load()},         {"speedtest", perms.speedtest.load()}};
}

static bool setPerm(const std::string &name, bool value) {
  if (name == "download") perms.download = value;
  else if (name == "upload") perms.upload = value;
  else if (name == "preview") perms.preview = value;
  else if (name == "hash") perms.hash = value;
  else if (name == "chat") perms.chat = value;
  else if (name == "speedtest") perms.speedtest = value;
  else return false;
  return true;
}

// ============ 响应工具 ============
static void respondJSON(httplib::Response &res, int code, const json &body) {
  res.status = code;
  res.set_header("Cache-Control", "no-store");
  res.set_content(body.dump(), "application/json; charset=utf-8");
}

static void forbid(httplib::Response &res, const std::string &msg) {
  respondJSON(res, 403, json{{"success", false}, {"message", msg}});
}

static bool isLocalhost(const httplib::Request &req) {
  std::string a = to_lower(req.remote_addr);
  return a == "127.0.0.1" || a == "::1" || a == "::ffff:127.0.0.1";
}

// ============ 系统信息 ============
static json getLocalIPs() {
  json arr = json::array();
  ULONG size = 0;
  GetAdaptersAddresses(AF_INET, GAA_FLAG_INCLUDE_PREFIX, nullptr, nullptr, &size);
  if (size == 0) return arr;
  std::vector<char> buf(size);
  auto *addrs = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data());
  if (GetAdaptersAddresses(AF_INET, GAA_FLAG_INCLUDE_PREFIX, nullptr, addrs, &size) != NO_ERROR)
    return arr;
  for (auto *a = addrs; a; a = a->Next) {
    if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
    for (auto *ua = a->FirstUnicastAddress; ua; ua = ua->Next) {
      if (!ua->Address.lpSockaddr) continue;
      if (ua->Address.lpSockaddr->sa_family != AF_INET) continue;
      char ip[INET_ADDRSTRLEN] = {0};
      auto *sin = reinterpret_cast<sockaddr_in *>(ua->Address.lpSockaddr);
      inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
      arr.push_back({{"name", w_to_u8(a->FriendlyName ? a->FriendlyName : L"")},
                     {"address", std::string(ip)}});
    }
  }
  return arr;
}

static std::string hostnameStr() {
  wchar_t buf[256];
  DWORD n = 256;
  if (GetComputerNameW(buf, &n)) return w_to_u8(std::wstring(buf, n));
  return "unknown";
}

static int cpuCount() {
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  return (int)si.dwNumberOfProcessors;
}

// ============ SHA-256（BCrypt） ============
static bool sha256_file(const fs::path &path, std::string &outHex) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  DWORD objLen = 0, cb = 0, hashLen = 0;
  BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(objLen), &cb, 0);
  BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hashLen), sizeof(hashLen), &cb, 0);
  std::vector<UCHAR> obj(objLen), digest(hashLen);
  if (BCryptCreateHash(alg, &hash, obj.data(), objLen, nullptr, 0, 0) < 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }
  std::ifstream ifs(path, std::ios::binary);
  if (!ifs) {
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }
  std::vector<char> buf(256 * 1024);
  while (ifs) {
    ifs.read(buf.data(), (std::streamsize)buf.size());
    std::streamsize n = ifs.gcount();
    if (n > 0) BCryptHashData(hash, reinterpret_cast<PUCHAR>(buf.data()), (ULONG)n, 0);
  }
  BCryptFinishHash(hash, digest.data(), hashLen, 0);
  static const char *hexd = "0123456789abcdef";
  outHex.clear();
  outHex.reserve(hashLen * 2);
  for (auto b : digest) {
    outHex.push_back(hexd[b >> 4]);
    outHex.push_back(hexd[b & 15]);
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  return true;
}

static void fillRandom(char *p, size_t n) {
  BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(p), (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
}

// ============ 外网 TCP 握手测延迟 ============
static long long pingExternal(const std::string &host) {
  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo *result = nullptr;
  if (getaddrinfo(host.c_str(), "443", &hints, &result) != 0 || !result) return -1;
  SOCKET s = socket(result->ai_family, result->ai_socktype, result->ai_protocol);
  if (s == INVALID_SOCKET) {
    freeaddrinfo(result);
    return -1;
  }
  u_long nb = 1;
  ioctlsocket(s, FIONBIO, &nb);
  auto t0 = std::chrono::steady_clock::now();
  auto elapsed = [&]() {
    return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - t0)
        .count();
  };
  long long ms = -1;
  int rc = connect(s, result->ai_addr, (int)result->ai_addrlen);
  if (rc == 0) {
    ms = elapsed();
  } else if (WSAGetLastError() == WSAEWOULDBLOCK) {
    fd_set wf;
    FD_ZERO(&wf);
    FD_SET(s, &wf);
    timeval tv{3, 0};
    int sel = select(0, nullptr, &wf, nullptr, &tv);
    if (sel > 0) {
      int err = 0;
      int len = sizeof(err);
      getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&err), &len);
      if (err == 0) ms = elapsed();
    }
  }
  closesocket(s);
  freeaddrinfo(result);
  return ms;
}

// ============ 共享文件解析（防目录穿越 + 防 symlink 逃逸） ============
struct ResolvedFile {
  fs::path path;
  unsigned long long size = 0;
  std::string name;
};

static std::optional<ResolvedFile> resolveShareFile(const std::string &name) {
  if (name.empty()) return std::nullopt;
  std::vector<std::string> segs = split_path(name);
  if (segs.empty() || has_dotdot(segs)) return std::nullopt;
  if (SELF_FILES.count(segs.back())) return std::nullopt;

  fs::path full = SHARE_DIR;
  for (auto &seg : segs) full /= u8_to_w(seg);

  if (!is_under(SHARE_DIR, full)) return std::nullopt;
  std::error_code ec;
  if (!fs::is_regular_file(full, ec)) return std::nullopt;
  if (!is_under_real(SHARE_DIR, full)) return std::nullopt;

  unsigned long long sz = fs::file_size(full, ec);
  if (ec) return std::nullopt;
  return ResolvedFile{full, sz, join_path(segs)};
}

// ============ 目录树扫描（深度 3，mtime 降序） ============
static json scanTree(const fs::path &dir, int depth) {
  json node;
  node["name"] = w_to_u8(dir.filename().wstring());
  node["dirs"] = json::array();
  node["files"] = json::array();
  if (depth > 3) return node;

  struct FileEnt {
    std::string name;
    unsigned long long size;
    long long mtime;
  };
  std::vector<FileEnt> files;
  std::error_code ec;

  fs::directory_iterator it(dir, ec);
  if (ec) return node;
  for (auto &entry : it) {
    std::string nm = w_to_u8(entry.path().filename().wstring());
    if (nm.empty() || nm[0] == '.') continue;
    if (nm == "chat-img") continue;
    std::error_code e2;
    if (entry.is_directory(e2)) {
      json sub = scanTree(entry.path(), depth + 1);
      if (!sub["files"].empty() || !sub["dirs"].empty()) node["dirs"].push_back(sub);
    } else if (entry.is_regular_file(e2)) {
      auto sz = entry.file_size(e2);
      auto mt = entry.last_write_time(e2);
      long long mti = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
                          mt.time_since_epoch())
                          .count();
      files.push_back({nm, (unsigned long long)sz, mti});
    }
  }
  std::sort(files.begin(), files.end(),
            [](const FileEnt &a, const FileEnt &b) { return a.mtime > b.mtime; });
  for (auto &f : files) {
    node["files"].push_back({{"name", f.name}, {"size", f.size}, {"mtimeMs", f.mtime}});
  }
  return node;
}

// 为目录树中每个文件标注 canDelete（请求者为上传者本人或 localhost）
static void annotateTree(json &node, const std::string &prefix, const std::string &cid,
                         bool isLocal) {
  for (auto &f : node["files"]) {
    std::string rel = prefix.empty() ? f["name"].get<std::string>()
                                     : prefix + "/" + f["name"].get<std::string>();
    bool can = isLocal;
    if (!can && !cid.empty()) {
      std::lock_guard<std::mutex> lk(uploadMetaMutex);
      auto it = uploadMeta.find(rel);
      can = (it != uploadMeta.end() && it->second.cid == cid);
    }
    f["canDelete"] = can;
  }
  for (auto &d : node["dirs"]) {
    std::string sub = prefix.empty() ? d["name"].get<std::string>()
                                     : prefix + "/" + d["name"].get<std::string>();
    annotateTree(d, sub, cid, isLocal);
  }
}

// ============ 流式发送文件（支持 Range，由 httplib 自动切片） ============
static bool serveFileStream(httplib::Response &res, const fs::path &path, unsigned long long size,
                            const std::string &contentType, const std::string &disposition) {
  auto ifs = std::make_shared<std::ifstream>(path, std::ios::binary);
  if (!ifs->is_open()) return false;
  if (!disposition.empty()) res.set_header("Content-Disposition", disposition);
  res.set_header("Accept-Ranges", "bytes");
  res.set_content_provider(
      (size_t)size, contentType,
      [ifs](size_t offset, size_t length, httplib::DataSink &sink) -> bool {
        ifs->clear();
        ifs->seekg((std::streamoff)offset, std::ios::beg);
        if (!*ifs) return false;
        const size_t CHUNK = 256 * 1024;
        std::vector<char> buf(std::min<size_t>(CHUNK, length ? length : 1));
        size_t remaining = length;
        while (remaining > 0) {
          size_t want = std::min<size_t>(buf.size(), remaining);
          ifs->read(buf.data(), (std::streamsize)want);
          std::streamsize got = ifs->gcount();
          if (got <= 0) return false;
          if (!sink.write(buf.data(), (size_t)got)) return false;
          remaining -= (size_t)got;
          if ((size_t)got < want) break;
        }
        return true;
      });
  return true;
}

// ============ SSE 广播 ============
static json chatPresence() {
  json names = json::array();
  std::lock_guard<std::mutex> lk(chatClientsMutex);
  for (auto &c : chatClients) names.push_back(c->name);
  return json{{"count", chatClients.size()}, {"names", names}};
}

static void sseBroadcast(const std::string &event, const json &data) {
  std::string payload = "event: " + event + "\ndata: " + data.dump() + "\n\n";
  std::lock_guard<std::mutex> lk(chatClientsMutex);
  for (auto &c : chatClients) c->enqueue(payload);
}

static json msgToJson(const ChatMessage &m) {
  return json{{"id", m.id},       {"time", m.time}, {"name", m.name},
              {"text", m.text},   {"images", m.images}};
}

// ============================================================================
// main
// ============================================================================
int main() {
  setupConsole();
  SetUnhandledExceptionFilter(unhandledFilter);

  try {
    // 程序目录 = exe 所在目录
    wchar_t exePath[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    PROGRAM_DIR = fs::path(std::wstring(exePath, n)).parent_path();
    SHARE_DIR = PROGRAM_DIR / L"share";
    CHAT_IMG_DIR = PROGRAM_DIR / L"chat-img";
    LOG_FILE = PROGRAM_DIR / L"error.log";

    std::error_code ec;
    fs::create_directories(SHARE_DIR, ec);
    fs::create_directories(CHAT_IMG_DIR, ec);

    // 初始化 Winsock
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);

    httplib::Server svr;
    g_server = &svr;
    svr.set_read_timeout(300, 0);
    svr.set_payload_max_length(12ULL * 1024 * 1024 * 1024);  // 允许 10GB 上传

    // ---------- 首页 ----------
    auto serveIndex = [](const httplib::Request &, httplib::Response &res) {
      res.set_header("Cache-Control", "no-store");
      res.set_content(std::string(reinterpret_cast<const char *>(INDEX_HTML), (size_t)INDEX_HTML_LEN),
                      "text/html; charset=utf-8");
    };
    svr.Get("/", serveIndex);
    svr.Get("/index.html", serveIndex);

    // ---------- 文件清单 ----------
    svr.Get("/files", [](const httplib::Request &req, httplib::Response &res) {
      std::string cid = req.get_header_value("X-Client-Id");
      json tree = scanTree(SHARE_DIR, 0);
      annotateTree(tree, "", cid, isLocalhost(req));
      respondJSON(res, 200, json{{"success", true}, {"data", tree}});
    });

    // ---------- 本机延迟 ----------
    svr.Get("/ping", [](const httplib::Request &, httplib::Response &res) {
      res.status = 200;
      res.set_header("Cache-Control", "no-store");
      res.set_content("{\"pong\":1}", "application/json; charset=utf-8");
    });

    // ---------- 外网延迟 ----------
    svr.Get("/ping-external", [](const httplib::Request &req, httplib::Response &res) {
      std::string host = req.get_param_value("host");
      static const std::regex hostRe("^[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$");
      if (!std::regex_match(host, hostRe)) {
        respondJSON(res, 400, json{{"error", "invalid host"}});
        return;
      }
      long long ms = pingExternal(host);
      respondJSON(res, 200, json{{"host", host}, {"ms", ms < 0 ? json(nullptr) : json(ms)}});
    });

    // ---------- 下载测速（无限随机流） ----------
    svr.Get("/speedtest", [](const httplib::Request &, httplib::Response &res) {
      if (!perms.speedtest.load()) { forbid(res, "测速功能已被禁用"); return; }
      res.set_header("Cache-Control", "no-store");
      res.set_chunked_content_provider(
          "application/octet-stream", [](size_t, httplib::DataSink &sink) -> bool {
            static thread_local std::vector<char> buf(256 * 1024);
            fillRandom(buf.data(), buf.size());
            return sink.write(buf.data(), buf.size());
          });
    });

    // ---------- 上传测速 ----------
    svr.Post("/upload-test", [](const httplib::Request &, httplib::Response &res,
                                const httplib::ContentReader &reader) {
      if (!perms.speedtest.load()) { forbid(res, "测速功能已被禁用"); return; }
      unsigned long long received = 0;
      bool over = false;
      bool ok = reader([&](const char *, size_t l) -> bool {
        received += l;
        if (received > UPLOAD_TEST_MAX) { over = true; return false; }
        return true;
      });
      if (over) { respondJSON(res, 413, json{{"error", "too large"}}); return; }
      if (!ok) { respondJSON(res, 400, json{{"error", "aborted"}}); return; }
      respondJSON(res, 200, json{{"received", received}});
    });

    // ---------- 下载 ----------
    svr.Get(R"(/download/(.*))", [](const httplib::Request &req, httplib::Response &res) {
      if (!perms.download.load()) { forbid(res, "下载功能已被禁用"); return; }
      std::string raw = url_decode(req.matches[1].str());
      auto f = resolveShareFile(raw);
      if (!f) {
        res.status = 404;
        res.set_content("文件不存在或不在共享目录", "text/plain; charset=utf-8");
        return;
      }
      if (!req.ranges.empty()) res.status = 206;
      res.set_header("Cache-Control", "no-store");
      std::string base = w_to_u8(f->path.filename().wstring());
      if (!serveFileStream(res, f->path, f->size, "application/octet-stream",
                           contentDisposition(base, true))) {
        res.status = 500;
        res.set_content("读取失败", "text/plain; charset=utf-8");
      }
    });

    // ---------- 上传（流式落盘） ----------
    svr.Put(R"(/upload/(.*))", [](const httplib::Request &req, httplib::Response &res,
                                  const httplib::ContentReader &reader) {
      if (!perms.upload.load()) { forbid(res, "上传功能已被禁用"); return; }
      std::string raw = url_decode(req.matches[1].str());
      std::vector<std::string> segs = split_path(raw);
      if (segs.empty() || has_dotdot(segs)) {
        respondJSON(res, 403, json{{"success", false}, {"message", "非法路径"}});
        return;
      }
      if (SELF_FILES.count(segs.back())) {
        respondJSON(res, 403, json{{"success", false}, {"message", "不能覆盖服务自身文件"}});
        return;
      }
      fs::path full = SHARE_DIR;
      for (auto &seg : segs) full /= u8_to_w(seg);
      if (!is_under(SHARE_DIR, full)) {
        respondJSON(res, 403, json{{"success", false}, {"message", "非法路径"}});
        return;
      }
      fs::path parent = full.parent_path();
      if (!is_under_real(SHARE_DIR, parent)) {
        respondJSON(res, 403, json{{"success", false}, {"message", "目标路径在共享目录外"}});
        return;
      }
      std::error_code ec;
      fs::create_directories(parent, ec);

      std::ofstream ofs(full, std::ios::binary | std::ios::trunc);
      if (!ofs) {
        respondJSON(res, 500, json{{"success", false}, {"message", "创建文件失败"}});
        return;
      }
      unsigned long long total = 0;
      bool over = false;
      bool ok = reader([&](const char *d, size_t l) -> bool {
        total += l;
        if (total > UPLOAD_MAX) { over = true; return false; }
        ofs.write(d, (std::streamsize)l);
        return ofs.good();
      });
      ofs.close();
      if (over) {
        std::error_code e;
        fs::remove(full, e);
        respondJSON(res, 413, json{{"success", false}, {"message", "文件超过 10GB 上限"}});
        return;
      }
      if (!ok) {
        std::error_code e;
        fs::remove(full, e);
        respondJSON(res, 500, json{{"success", false}, {"message", "上传失败"}});
        return;
      }
      {
        std::lock_guard<std::mutex> lk(hashCacheMutex);
        hashCache.erase(join_path(segs));
      }
      {
        std::lock_guard<std::mutex> lk(uploadMetaMutex);
        long long nowMs = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
        uploadMeta[join_path(segs)] = UploadMeta{url_decode(req.get_header_value("X-Visitor-Name")),
                                                 req.get_header_value("X-Client-Id"), nowMs};
      }
      sseBroadcast("files-changed", json{{"path", join_path(segs)}});
      respondJSON(res, 200,
                  json{{"success", true}, {"data", {{"path", join_path(segs)}, {"size", total}}}});
    });

    // ---------- 在线预览 ----------
    svr.Get(R"(/preview/(.*))", [](const httplib::Request &req, httplib::Response &res) {
      if (!perms.preview.load()) { forbid(res, "预览功能已被禁用"); return; }
      std::string raw = url_decode(req.matches[1].str());
      auto f = resolveShareFile(raw);
      if (!f) {
        res.status = 404;
        res.set_content("文件不存在或不在共享目录", "text/plain; charset=utf-8");
        return;
      }
      std::string ext = to_lower(w_to_u8(f->path.extension().wstring()));
      auto it = PREVIEW_TYPES.find(ext);
      if (it == PREVIEW_TYPES.end()) {
        respondJSON(res, 415, json{{"success", false}, {"message", "该类型不支持在线预览"}});
        return;
      }
      std::string ct = it->second;
      if (ct.rfind("text/", 0) == 0) ct += "; charset=utf-8";
      res.set_header("Cache-Control", "no-store");
      std::string base = w_to_u8(f->path.filename().wstring());
      if (!serveFileStream(res, f->path, f->size, ct, contentDisposition(base, false))) {
        res.status = 500;
        res.set_content("读取失败", "text/plain; charset=utf-8");
      }
    });

    // ---------- SHA-256 ----------
    svr.Get(R"(/hash/(.*))", [](const httplib::Request &req, httplib::Response &res) {
      if (!perms.hash.load()) { forbid(res, "哈希功能已被禁用"); return; }
      std::string raw = url_decode(req.matches[1].str());
      auto f = resolveShareFile(raw);
      if (!f) {
        res.status = 404;
        res.set_content("文件不存在或不在共享目录", "text/plain; charset=utf-8");
        return;
      }
      std::error_code ec;
      unsigned long long sz = fs::file_size(f->path, ec);
      auto mt = fs::last_write_time(f->path, ec);
      long long mti = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
                          mt.time_since_epoch())
                          .count();
      {
        std::lock_guard<std::mutex> lk(hashCacheMutex);
        auto it = hashCache.find(f->name);
        if (it != hashCache.end() && it->second.size == sz && it->second.mtime == mti) {
          respondJSON(res, 200, json{{"success", true}, {"data", {{"sha256", it->second.hash}}}});
          return;
        }
      }
      std::string hex;
      if (!sha256_file(f->path, hex)) {
        respondJSON(res, 500, json{{"success", false}, {"message", "计算失败"}});
        return;
      }
      {
        std::lock_guard<std::mutex> lk(hashCacheMutex);
        hashCache[f->name] = HashEntry{hex, sz, mti};
        if (hashCache.size() > HASH_CACHE_MAX) hashCache.erase(hashCache.begin());
      }
      respondJSON(res, 200, json{{"success", true}, {"data", {{"sha256", hex}}}});
    });

    // ---------- 删除（仅上传者本人或 localhost） ----------
    svr.Delete(R"(/delete/(.*))", [](const httplib::Request &req, httplib::Response &res) {
      std::string raw = url_decode(req.matches[1].str());
      auto f = resolveShareFile(raw);
      if (!f) {
        respondJSON(res, 404, json{{"success", false}, {"message", "文件不存在"}});
        return;
      }
      std::string cid = req.get_header_value("X-Client-Id");
      bool allowed = isLocalhost(req);
      if (!allowed && !cid.empty()) {
        std::lock_guard<std::mutex> lk(uploadMetaMutex);
        auto it = uploadMeta.find(f->name);
        allowed = (it != uploadMeta.end() && it->second.cid == cid);
      }
      if (!allowed) {
        respondJSON(res, 403, json{{"success", false}, {"message", "只能删除自己上传的文件"}});
        return;
      }
      std::error_code ec;
      fs::remove(f->path, ec);
      if (ec) {
        respondJSON(res, 500, json{{"success", false}, {"message", "删除失败"}});
        return;
      }
      {
        std::lock_guard<std::mutex> lk(uploadMetaMutex);
        uploadMeta.erase(f->name);
      }
      {
        std::lock_guard<std::mutex> lk(hashCacheMutex);
        hashCache.erase(f->name);
      }
      // 清理因此产生的空目录（向上直到 SHARE_DIR）
      fs::path dir = f->path.parent_path();
      while (dir != SHARE_DIR && is_under(SHARE_DIR, dir)) {
        std::error_code e2;
        if (fs::is_empty(dir, e2) && !e2) {
          fs::remove(dir, e2);
          dir = dir.parent_path();
        } else {
          break;
        }
      }
      sseBroadcast("files-changed", json{{"path", f->name}, {"deleted", true}});
      respondJSON(res, 200, json{{"success", true}, {"data", {{"path", f->name}}}});
    });

    // ---------- 聊天 SSE ----------
    svr.Get("/chat/stream", [](const httplib::Request &req, httplib::Response &res) {
      if (!perms.chat.load()) { forbid(res, "聊天功能已被禁用"); return; }
      auto client = std::make_shared<ChatClient>();
      client->cid = req.get_param_value("cid");
      {
        std::lock_guard<std::mutex> lk(chatClientsMutex);
        chatClients.push_back(client);
      }
      json hist = json::array();
      {
        std::lock_guard<std::mutex> lk(chatHistoryMutex);
        for (auto &m : chatHistory) hist.push_back(msgToJson(m));
      }
      client->enqueue("event: history\ndata: " + hist.dump() + "\n\n");
      client->enqueue("event: permission\ndata: " + permsJson().dump() + "\n\n");
      sseBroadcast("presence", chatPresence());

      res.set_header("Cache-Control", "no-store");
      res.set_header("X-Accel-Buffering", "no");
      res.set_chunked_content_provider(
          "text/event-stream; charset=utf-8",
          [client](size_t, httplib::DataSink &sink) -> bool {
            std::unique_lock<std::mutex> lk(client->m);
            client->cv.wait_for(lk, std::chrono::seconds(20),
                                [&] { return !client->queue.empty() || !client->alive; });
            if (!client->alive) return false;
            while (!client->queue.empty()) {
              std::string item = std::move(client->queue.front());
              client->queue.pop_front();
              lk.unlock();
              bool ok = sink.write(item.data(), item.size());
              lk.lock();
              if (!ok) { client->alive = false; return false; }
            }
            return true;
          },
          [client](bool) {
            client->alive = false;
            {
              std::lock_guard<std::mutex> lk(chatClientsMutex);
              chatClients.erase(std::remove(chatClients.begin(), chatClients.end(), client),
                                chatClients.end());
            }
            sseBroadcast("presence", chatPresence());
          });
    });

    // ---------- 主动离开（pagehide sendBeacon），立即移除在线状态 ----------
    svr.Post("/chat/leave", [](const httplib::Request &req, httplib::Response &res) {
      std::string cid = req.get_param_value("cid");
      if (!cid.empty()) {
        std::vector<std::shared_ptr<ChatClient>> matched;
        {
          std::lock_guard<std::mutex> lk(chatClientsMutex);
          for (auto &c : chatClients) if (c->cid == cid) matched.push_back(c);
        }
        for (auto &c : matched) { c->alive = false; c->cv.notify_one(); }
      }
      respondJSON(res, 200, json{{"success", true}});
    });

    // ---------- 发送聊天消息 ----------
    svr.Post("/chat/send", [](const httplib::Request &req, httplib::Response &res) {
      if (!perms.chat.load()) { forbid(res, "聊天功能已被禁用"); return; }
      json data;
      try {
        data = json::parse(req.body);
      } catch (...) {
        res.status = 400;
        res.set_content("bad request", "text/plain; charset=utf-8");
        return;
      }
      std::string rawName = utf8_truncate(trim(data.value("name", std::string())), 20);
      if (rawName.empty()) rawName = "匿名";
      std::string text = utf8_truncate(data.value("text", std::string()), CHAT_MSG_MAX);

      // 收集已占用昵称
      std::set<std::string> taken;
      {
        std::lock_guard<std::mutex> lk(chatClientsMutex);
        for (auto &c : chatClients) taken.insert(c->name);
      }
      {
        std::lock_guard<std::mutex> lk(chatHistoryMutex);
        for (auto &m : chatHistory) taken.insert(m.name);
      }
      std::string finalName = rawName;
      if (taken.count(rawName)) {
        bool firstSeen = false;
        int maxN = 0;
        std::string prefix = rawName + "#";
        for (auto &t : taken) {
          if (t == rawName) { firstSeen = true; continue; }
          if (t.rfind(prefix, 0) == 0) {
            std::string suffix = t.substr(prefix.size());
            if (!suffix.empty() &&
                std::all_of(suffix.begin(), suffix.end(),
                            [](char c) { return c >= '0' && c <= '9'; })) {
              int v = std::atoi(suffix.c_str());
              if (v > maxN) maxN = v;
            }
          }
        }
        finalName = firstSeen ? (rawName + "#" + std::to_string(maxN + 1)) : (rawName + "#2");
      }

      std::vector<std::string> images;
      if (data.contains("images") && data["images"].is_array()) {
        for (auto &img : data["images"]) {
          if (images.size() >= 9) break;
          if (img.is_string()) {
            std::string u = img.get<std::string>();
            if (u.rfind("/chat-img/", 0) == 0) images.push_back(u);
          }
        }
      }

      auto now = std::chrono::system_clock::now().time_since_epoch();
      long long ms = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
      char rnd[8];
      fillRandom(rnd, sizeof(rnd));
      char idbuf[64];
      std::snprintf(idbuf, sizeof(idbuf), "%llx%02x%02x", (unsigned long long)ms,
                    (unsigned char)rnd[0], (unsigned char)rnd[1]);

      ChatMessage msg;
      msg.id = idbuf;
      msg.time = ms;
      msg.name = finalName;
      msg.text = text;
      msg.images = images;
      {
        std::lock_guard<std::mutex> lk(chatHistoryMutex);
        chatHistory.push_back(msg);
        while (chatHistory.size() > CHAT_HISTORY_MAX) chatHistory.pop_front();
      }
      sseBroadcast("message", msgToJson(msg));
      respondJSON(res, 200, json{{"success", true}, {"name", finalName}});
    });

    // ---------- 聊天图片 ----------
    svr.Get(R"(/chat-img/(.*))", [](const httplib::Request &req, httplib::Response &res) {
      std::string raw = url_decode(req.matches[1].str());
      std::vector<std::string> segs = split_path(raw);
      if (segs.empty() || has_dotdot(segs)) {
        res.status = 400;
        res.set_content("bad path", "text/plain; charset=utf-8");
        return;
      }
      fs::path full = CHAT_IMG_DIR;
      for (auto &seg : segs) full /= u8_to_w(seg);
      if (!is_under(CHAT_IMG_DIR, full)) {
        res.status = 400;
        res.set_content("bad path", "text/plain; charset=utf-8");
        return;
      }
      std::error_code ec;
      if (!fs::is_regular_file(full, ec)) {
        res.status = 404;
        res.set_content("not found", "text/plain; charset=utf-8");
        return;
      }
      unsigned long long sz = fs::file_size(full, ec);
      std::string base = w_to_u8(full.filename().wstring());
      res.set_header("Cache-Control", "public, max-age=3600");
      if (!serveFileStream(res, full, sz, "application/octet-stream",
                           contentDisposition(base, false))) {
        res.status = 500;
        res.set_content("读取失败", "text/plain; charset=utf-8");
      }
    });

    // ---------- 系统信息 ----------
    svr.Get("/api/info", [](const httplib::Request &, httplib::Response &res) {
      json info = {
          {"port", PORT},
          {"localIPs", getLocalIPs()},
          {"hostname", hostnameStr()},
          {"platform", "win32"},
#ifdef _M_X64
          {"arch", "x64"},
#else
          {"arch", "x86"},
#endif
          {"cpus", cpuCount()},
          {"nodeVersion", std::string("C++/MSVC ") + std::to_string(_MSC_VER)},
          {"permissions", permsJson()}};
      respondJSON(res, 200, json{{"success", true}, {"data", info}});
    });

    // ---------- 客户端信息 ----------
    svr.Get("/api/client-info", [](const httplib::Request &req, httplib::Response &res) {
      json d = {{"ip", req.remote_addr},
                {"userAgent", req.get_header_value("User-Agent")},
                {"host", req.get_header_value("Host")},
                {"isLocalhost", isLocalhost(req)}};
      respondJSON(res, 200, json{{"success", true}, {"data", d}});
    });

    // ---------- 本机管理：状态 ----------
    svr.Get("/api/admin/status", [](const httplib::Request &req, httplib::Response &res) {
      if (!isLocalhost(req)) { forbid(res, "仅限本机访问"); return; }
      respondJSON(res, 200, json{{"success", true}, {"data", {{"permissions", permsJson()}}}});
    });

    // ---------- 本机管理：切换权限 ----------
    svr.Post("/api/admin/permission", [](const httplib::Request &req, httplib::Response &res) {
      if (!isLocalhost(req)) { forbid(res, "仅限本机访问"); return; }
      json data;
      try {
        data = json::parse(req.body);
      } catch (...) {
        respondJSON(res, 400, json{{"success", false}, {"message", "请求体错误"}});
        return;
      }
      std::string name = data.value("name", std::string());
      bool value = data.value("value", false);
      if (!setPerm(name, value)) {
        respondJSON(res, 400, json{{"success", false}, {"message", "未知权限"}});
        return;
      }
      sseBroadcast("permission", permsJson());
      respondJSON(res, 200,
                  json{{"success", true}, {"data", {{"name", name}, {"value", value},
                                                    {"permissions", permsJson()}}}});
    });

    // ---------- 心跳线程 ----------
    std::thread heartbeat([] {
      while (g_running.load()) {
        for (int i = 0; i < 5 && g_running.load(); ++i)
          std::this_thread::sleep_for(std::chrono::seconds(1));
        if (!g_running.load()) break;
        std::lock_guard<std::mutex> lk(chatClientsMutex);
        for (auto &c : chatClients) c->enqueue(": ping\n\n");
      }
    });
    heartbeat.detach();

    // ---------- 启动 ----------
    std::printf("=======================================================\n");
    std::printf("  LanBridge (C++)\n");
    if (!svr.bind_to_port(HOST, PORT)) {
      std::printf("-------------------------------------------------------\n");
      std::printf("  端口 %d 已被占用，请先关闭占用该端口的程序后重试\n", PORT);
      std::printf("  查询占用进程: netstat -ano | findstr :%d\n", PORT);
      std::printf("=======================================================\n");
      g_running = false;
      return 1;
    }
    std::printf("  Server started\n\n");
    std::printf("  Local:   http://localhost:%d\n", PORT);
    json ips = getLocalIPs();
    if (!ips.empty()) {
      for (auto &ip : ips) {
        std::printf("  LAN:     http://%s:%d  (%s)\n", ip["address"].get<std::string>().c_str(),
                    PORT, ip["name"].get<std::string>().c_str());
      }
    } else {
      std::printf("  LAN:     (no LAN IP detected)\n");
    }
    std::printf("  Share:   %s\n", w_to_u8(SHARE_DIR.wstring()).c_str());
    std::printf("  Chat:    %s\n", w_to_u8(CHAT_IMG_DIR.wstring()).c_str());
    std::printf("\n");
    std::printf("  Tip: do NOT click URLs in this window - right-click to copy,\n");
    std::printf("       or open browser and type the address manually.\n");
    std::printf("       Press Ctrl+C in this window to stop the server.\n");
    std::printf("  提示: VM 网络需为桥接模式；Windows 防火墙若拦截请放行端口 %d\n", PORT);
    std::printf("=======================================================\n");
    std::fflush(stdout);

    svr.listen_after_bind();
    g_running = false;
    return 0;
  } catch (const std::exception &e) {
    logError("main", e.what());
    return 1;
  } catch (...) {
    logError("main", "unknown exception");
    return 1;
  }
}
