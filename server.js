// LanBridge 静态服务（零依赖，仅 Node 内置模块）
// 支持两种运行模式：
//   1) 开发模式：node server.js  -> 从 PROGRAM_DIR 读取 index.html
//   2) SEA 模式：webshare.exe    -> 从 SEA 内嵌资源读取 index.html
// 启动: node server.js  或  双击 webshare.exe
// 访问: 本机 http://localhost:24496  虚拟机 http://宿主机局域网IP:24496

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const net = require('net')

// Windows 旧版 cmd 默认 GBK，切换到 UTF-8 避免中文输出乱码（无害，失败则忽略）
try {
  require('child_process').execSync('chcp 65001', { stdio: 'ignore' })
} catch (e) { /* ignore */ }

// 禁用控制台「快速编辑模式」，防止鼠标拖选/点击终端里的 URL 误触发前台进程关闭
// （仅对传统 conhost 有效；Windows Terminal / PowerShell 本无效但也无害）
try {
  require('child_process').execSync('mode con /quickedit off', { stdio: 'ignore' })
} catch (e) { /* ignore */ }

// ============ 全局异常日志（定位 SEA EXE 闪退） ============
let LOG_FILE = null
// SEA 模式下 index.html 资产缓存（启动时一次加载，重复请求复用）
let SEA_INDEX_BUF = null
function logError(tag, err) {
  const line = '[' + new Date().toISOString() + '] ' + tag + ': ' +
    (err && err.stack ? err.stack : String(err)) + '\n'
  try { console.error(line) } catch (e) {}
  try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line) } catch (e) {}
}
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason)
})

// ============ 路径解析：普通模式 vs SEA 模式 ============

function isSea() {
  try { return require('node:sea').isSea() === true } catch (e) { return false }
}

// 程序所在目录：普通模式 = __dirname，SEA 模式 = EXE 所在目录
function getProgramDir() {
  return isSea() ? path.dirname(process.execPath) : __dirname
}

const PROGRAM_DIR = getProgramDir()
const SHARE_DIR = path.join(PROGRAM_DIR, 'share')
const CHAT_IMG_DIR = path.join(PROGRAM_DIR, 'chat-img')

LOG_FILE = path.join(PROGRAM_DIR, 'error.log')

// 启动时自动创建 share/ 和 chat-img/（不自动清空旧内容）
for (const d of [SHARE_DIR, CHAT_IMG_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { /* ignore */ }
}

// 读取 index.html：SEA 模式从嵌入资源，普通模式从盘读取
function readIndexHTML() {
  if (isSea()) {
    if (!SEA_INDEX_BUF) {
      let raw
      try {
        raw = require('node:sea').getAsset('index.html')
      } catch (e) {
        return Promise.reject(new Error('sea.getAsset 抛错: ' + e.message))
      }
      if (!raw) return Promise.reject(new Error('index.html asset missing in SEA'))
      // Node 26 的 sea.getAsset 返回 ArrayBuffer（不是 Buffer），需转为 Buffer
      SEA_INDEX_BUF = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    }
    return Promise.resolve(SEA_INDEX_BUF)
  }
  return new Promise((resolve, reject) => {
    fs.readFile(path.join(PROGRAM_DIR, 'index.html'), (err, data) => {
      if (err) reject(err); else resolve(data)
    })
  })
}

const PORT = 24496
const HOST = '0.0.0.0'

// 自身文件：不出现在下载列表，也不可被下载/覆盖
const SELF_FILES = new Set(['server.js', 'index.html', 'README.md', 'sea-config.json', 'build.bat', 'package.json'])

// 聊天状态：在线连接、最近消息（仅内存）
const chatClients = new Set() // { res, name }
const chatHistory = []         // [{ id, time, name, text, images: [url,...] }]
const CHAT_HISTORY_MAX = 100
const CHAT_MSG_MAX = 200

// ============ 本机管理：权限、应用层共享剪贴板 ============

// 功能权限开关（默认全部开启，保持现有行为）
const permissions = {
  download: true,
  upload: true,
  preview: true,
  hash: true,
  clipboard: true,
  chat: true,
  speedtest: true,
}

// 应用层共享剪贴板（双向 slot，仅内存，不落盘）
const clipboards = {
  host: { text: '', time: 0 },
  vm:   { text: '', time: 0 },
}

function isLocalhost(req) {
  const addr = (req.socket.remoteAddress || '').toLowerCase()
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function forbid(res, msg) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ success: false, message: msg || '已被禁用' }))
}

// 通用 SSE 广播（chat 与管理共享同一连接）
function sseBroadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
  for (const c of chatClients) {
    try { c.res.write(payload) } catch (e) { /* 客户端断开 */ }
  }
}

function chatPresence() {
  const names = []
  for (const c of chatClients) names.push(c.name)
  return { count: chatClients.size, names }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) { req.destroy(); reject(new Error('too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const str = Buffer.concat(chunks).toString('utf-8')
        resolve(JSON.parse(str))
      } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// 找出本机局域网 IPv4 地址
function getLocalIPs() {
  const ips = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push({ name, address: info.address })
      }
    }
  }
  return ips
}

// 递归扫描 SHARE_DIR（深度上限 3 层），返回目录树 { name, dirs: [...], files: [...] }
function scanTree(dir, depth) {
  const node = { name: path.basename(dir), dirs: [], files: [] }
  if (depth > 3) return node
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'chat-img') continue  // 永远不列 chat-img（即使有人把它放在 share/ 里）
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = scanTree(full, depth + 1)
      if (sub.files.length > 0 || sub.dirs.length > 0) node.dirs.push(sub)
    } else {
      const stat = fs.statSync(full)
      node.files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  // 按修改时间降序（最新放的排前面）
  node.files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return node
}

// 校验共享路径：仅允许 share/ 内文件（支持子目录），防目录穿越 + 防 symlink 逃逸
// 返回 { name, path, size } 或 null
function resolveShareFile(name) {
  if (!name || typeof name !== 'string') return null
  const segments = name.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0) return null
  if (segments.some(s => s === '..')) return null
  if (SELF_FILES.has(segments[segments.length - 1])) return null
  const full = path.join(SHARE_DIR, ...segments)
  // 字符串层校验：必须在 SHARE_DIR 内
  const rel = path.relative(SHARE_DIR, full)
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return null
  const stat = fs.statSync(full, { throwIfNoEntry: false })
  if (!stat || !stat.isFile()) return null
  // 真实路径层校验：防 symlink 逃逸
  let real
  try { real = fs.realpathSync(full) } catch (e) { return null }
  const relReal = path.relative(SHARE_DIR, real)
  if (relReal === '' || path.isAbsolute(relReal) || relReal === '..' || relReal.startsWith('..' + path.sep)) return null
  return { name: segments.join('/'), path: full, size: stat.size }
}

// JSON 响应（幂等：已发送/已断开则忽略）
function respondJSON(res, code, body) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

// Range 断点续传：解析 "bytes=start-end"
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!m) return null
  let start = m[1] === '' ? undefined : parseInt(m[1], 10)
  let end = m[2] === '' ? undefined : parseInt(m[2], 10)
  if (start === undefined) {
    // 无 start 时表示最后 N 字节 ("bytes=-500")
    if (end === undefined || end === 0) return null
    start = Math.max(size - end, 0)
    end = size - 1
  } else {
    if (end === undefined) end = size - 1
    if (start > end) return null
  }
  if (start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

// RFC 5987 中文文件名编码（同时给双值，老浏览器也有 fallback）
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encoded
}

function handleDownload(req, res, file) {
  const dlName = path.basename(file.name)
  const rangeHeader = req.headers.range
  if (rangeHeader) {
    const range = parseRange(rangeHeader, file.size)
    if (!range) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + file.size })
      res.end()
      return
    }
    const stream = fs.createReadStream(file.path, { start: range.start, end: range.end })
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(dlName),
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + file.size,
      'Content-Length': range.end - range.start + 1,
      'Cache-Control': 'no-store',
    })
    stream.pipe(res)
    return
  }
  const stream = fs.createReadStream(file.path)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(dlName),
    'Accept-Ranges': 'bytes',
    'Content-Length': file.size,
    'Cache-Control': 'no-store',
  })
  stream.pipe(res)
}

// 上传回传：PUT /upload/<相对路径>，body 流式写文件到 SHARE_DIR，不设大小上限
function handleUpload(req, res, raw) {
  const segments = decodeURIComponent(raw).replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0 || segments.some(s => s === '..')) {
    respondJSON(res, 403, { success: false, message: '非法路径' })
    return
  }
  if (SELF_FILES.has(segments[segments.length - 1])) {
    respondJSON(res, 403, { success: false, message: '不能覆盖服务自身文件' })
    return
  }
  const relPath = segments.join('/')
  const full = path.join(SHARE_DIR, ...segments)
  const rel = path.relative(SHARE_DIR, full)
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    respondJSON(res, 403, { success: false, message: '非法路径' })
    return
  }
  // 防 symlink 逃逸：父目录如果在 share/ 外则拒绝
  const parent = path.dirname(full)
  let parentReal
  try { parentReal = fs.realpathSync(parent) } catch (e) { parentReal = parent }
  const relParent = path.relative(SHARE_DIR, parentReal)
  if (relParent === '..' || relParent.startsWith('..' + path.sep)) {
    respondJSON(res, 403, { success: false, message: '目标路径在共享目录外' })
    return
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
  } catch (e) {
    respondJSON(res, 500, { success: false, message: '创建目录失败' })
    return
  }
  const ws = fs.createWriteStream(full)
  let size = 0
  let aborted = false
  const UPLOAD_MAX = 10 * 1024 * 1024 * 1024 // 单文件 10GB
  const fail = (code, msg) => {
    if (aborted) return
    aborted = true
    ws.destroy()
    fs.unlink(full, () => {}) // 清理半成品
    if (!res.headersSent) respondJSON(res, code || 500, { success: false, message: msg || '上传失败' })
  }
  req.on('data', chunk => {
    size += chunk.length
    if (size > UPLOAD_MAX) { fail(413, '文件超过 10GB 上限'); req.destroy() }
  })
  req.on('error', () => fail())
  req.on('aborted', () => fail())
  ws.on('error', () => fail())
  ws.on('finish', () => {
    if (aborted) return
    hashCache.delete(relPath)
    respondJSON(res, 200, { success: true, data: { path: relPath, size } })
  })
  req.pipe(ws)
}

// 在线预览：文本/MD/JSON/图片/PDF 内联展示
const PREVIEW_TYPES = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.json', 'application/json'],
  ['.log', 'text/plain'], ['.csv', 'text/plain'], ['.ini', 'text/plain'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'],
])

function handlePreview(req, res, file) {
  const ct = PREVIEW_TYPES.get(path.extname(file.name).toLowerCase())
  if (!ct) {
    respondJSON(res, 415, { success: false, message: '该类型不支持在线预览' })
    return
  }
  const stream = fs.createReadStream(file.path)
  stream.on('error', () => { res.destroy() })
  res.writeHead(200, {
    'Content-Type': ct + (ct.startsWith('text/') ? '; charset=utf-8' : ''),
    'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(file.name)),
    'Content-Length': file.size,
    'Cache-Control': 'no-store',
  })
  stream.pipe(res)
}

// SHA256 哈希：流式计算 + 内存缓存（size/mtime 变化时自动重算）
const hashCache = new Map() // relPath -> { hash, size, mtimeMs }

function handleHash(req, res, file) {
  const stat = fs.statSync(file.path)
  const cached = hashCache.get(file.name)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    respondJSON(res, 200, { success: true, data: { sha256: cached.hash } })
    return
  }
  const h = crypto.createHash('sha256')
  const stream = fs.createReadStream(file.path)
  stream.on('error', () => respondJSON(res, 500, { success: false, message: '计算失败' }))
  stream.on('data', chunk => h.update(chunk))
  stream.on('end', () => {
    const hash = h.digest('hex')
    hashCache.set(file.name, { hash, size: stat.size, mtimeMs: stat.mtimeMs })
    if (hashCache.size > 200) hashCache.delete(hashCache.keys().next().value) // 缓存上限
    respondJSON(res, 200, { success: true, data: { sha256: hash } })
  })
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    // 普通模式从盘读，SEA 模式从内嵌资源读
    readIndexHTML().then(data => {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(data)
    }).catch(err => {
      if (res.headersSent || res.writableEnded) {
        console.error('  [SEA] /index.html 错误但响应已发送: ' + err.message)
        return
      }
      console.error('  [SEA] /index.html 读取失败: ' + err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Cannot read index.html: ' + err.message)
    })
    return
  }

  // 文件清单 API：递归扫描 SHARE_DIR
  if (req.url === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ success: true, data: scanTree(SHARE_DIR, 0) }))
    return
  }

  // 本服务器延迟：极小响应，供浏览器测 HTTP 往返时间
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('{"pong":1}')
    return
  }

  // 外网延迟：服务器用 TCP 握手代测（浏览器无法直接连接外部服务器）
  // host 仅允许域名格式，防注入；超时/失败返回 ms=null
  if (req.url.startsWith('/ping-external')) {
    const host = new URL(req.url, 'http://x').searchParams.get('host') || ''
    if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(host)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid host' }))
      return
    }
    const start = Date.now()
    const sock = net.createConnection({ host, port: 443 })
    sock.setTimeout(3000)
    const done = (ms) => {
      sock.destroy()
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ host, ms }))
      }
    }
    sock.once('connect', () => done(Date.now() - start))
    sock.once('timeout', () => done(null))
    sock.once('error', () => done(null))
    return
  }

  // 下载测速：无限随机字节流（无 Content-Length），由客户端控制时长
  if (req.url.startsWith('/speedtest')) {
    if (!permissions.speedtest) { forbid(res, '测速功能已被禁用'); return }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.on('error', () => { /* 客户端断开时忽略 */ })
    const CHUNK = 256 * 1024
    let alive = true
    const writeNext = () => {
      while (alive) {
        if (!res.write(crypto.randomBytes(CHUNK))) {
          res.once('drain', writeNext)
          return
        }
      }
    }
    req.on('close', () => { alive = false })
    writeNext()
    return
  }

  // 上传测速：接收请求体，丢弃并统计字节数（上限 500MB）
  if (req.url === '/upload-test') {
    if (!permissions.speedtest) { forbid(res, '测速功能已被禁用'); return }
    let received = 0
    const MAX = 500 * 1024 * 1024
    const respond = (code, body) => {
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
    }
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > MAX) {
        respond(413, { error: 'too large' })
        req.destroy()
      }
    })
    req.on('end', () => respond(200, { received }))
    req.on('error', () => {})
    return
  }

  // 下载：/download/<路径>
  if (req.url.startsWith('/download/')) {
    if (!permissions.download) { forbid(res, '下载功能已被禁用'); return }
    const raw = decodeURIComponent(req.url.slice('/download/'.length))
    const file = resolveShareFile(raw)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('文件不存在或不在共享目录')
      return
    }
    handleDownload(req, res, file)
    return
  }

  // 上传回传：PUT /upload/<相对路径>（不限大小，流式落盘）
  if (req.method === 'PUT' && req.url.startsWith('/upload/')) {
    if (!permissions.upload) { forbid(res, '上传功能已被禁用'); return }
    handleUpload(req, res, req.url.slice('/upload/'.length))
    return
  }

  // 在线预览：GET /preview/<路径>
  if (req.url.startsWith('/preview/')) {
    if (!permissions.preview) { forbid(res, '预览功能已被禁用'); return }
    const raw = decodeURIComponent(req.url.slice('/preview/'.length))
    const file = resolveShareFile(raw)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('文件不存在或不在共享目录')
      return
    }
    handlePreview(req, res, file)
    return
  }

  // SHA256 哈希：GET /hash/<路径>
  if (req.url.startsWith('/hash/')) {
    if (!permissions.hash) { forbid(res, '哈希功能已被禁用'); return }
    const raw = decodeURIComponent(req.url.slice('/hash/'.length))
    const file = resolveShareFile(raw)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('文件不存在或不在共享目录')
      return
    }
    handleHash(req, res, file)
    return
  }

  // ============ 实时聊天 ============

  // SSE 聊天事件流：GET /chat/stream
  if (req.url === '/chat/stream') {
    if (!permissions.chat) { forbid(res, '聊天功能已被禁用'); return }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // 临时名（连入时还没设昵称），客户端连接后可能改名；message 事件以消息内 name 为准
    const client = { res, name: '匿名' }
    chatClients.add(client)
    res.write('event: history\ndata: ' + JSON.stringify(chatHistory.slice(-CHAT_HISTORY_MAX)) + '\n\n')
    // 首次连接推送当前权限与剪贴板状态
    res.write('event: permission\ndata: ' + JSON.stringify(permissions) + '\n\n')
    res.write('event: clipboard-state\ndata: ' + JSON.stringify(clipboards) + '\n\n')
    sseBroadcast('presence', chatPresence())
    const hb = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 30000)
    req.on('close', () => {
      clearInterval(hb)
      chatClients.delete(client)
      sseBroadcast('presence', chatPresence())
    })
    return
  }

  // 发送聊天消息：POST /chat/send  body: { name, text, images: [url,...] }
  if (req.method === 'POST' && req.url === '/chat/send') {
    if (!permissions.chat) { forbid(res, '聊天功能已被禁用'); return }
    readJsonBody(req).then((data) => {
      const rawName = String(data.name || '').trim().slice(0, 20) || '匿名'
      let text = String(data.text || '').slice(0, CHAT_MSG_MAX)
      // 去重 #N：统计当前活跃名 + 历史名中出现 rawName 的次数，作为新增的序号
      const taken = new Set()
      for (const c of chatClients) taken.add(c.name)
      for (const m of chatHistory) taken.add(m.name)
      let finalName = rawName
      if (taken.has(rawName)) {
        const re = new RegExp('^' + rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:#(\\d+))?$')
        let maxN = 0
        let firstSeen = false
        for (const t of taken) {
          const m2 = re.exec(t)
          if (m2) {
            if (!m2[1]) { firstSeen = true; continue }
            const n = parseInt(m2[1], 10)
            if (n > maxN) maxN = n
          }
        }
        finalName = firstSeen ? (rawName + '#' + (maxN + 1)) : (rawName + '#2')
      }
      const images = Array.isArray(data.images) ? data.images.filter(s => typeof s === 'string' && s.startsWith('/chat-img/')).slice(0, 9) : []
      const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        time: Date.now(),
        name: finalName,
        text: text,
        images: images,
      }
      chatHistory.push(msg)
      if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MAX)
      sseBroadcast('message', msg)
      try { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ success: true, name: finalName })) } catch (e) {}
    }).catch(() => {
      try { res.writeHead(400); res.end('bad request') } catch (e) {}
    })
    return
  }

  // 聊天图片下载/预览：GET /chat-img/<路径>，强制 inline
  if (req.url.startsWith('/chat-img/')) {
    const rel = req.url.slice('/chat-img/'.length)
    const segments = rel.replace(/\\/g, '/').split('/').filter(s => s && s !== '.')
    if (segments.length === 0 || segments.some(s => s === '..')) {
      res.writeHead(400); res.end('bad path'); return
    }
    const full = path.join(CHAT_IMG_DIR, ...segments)
    const relCheck = path.relative(CHAT_IMG_DIR, full)
    if (relCheck === '' || path.isAbsolute(relCheck) || relCheck === '..' || relCheck.startsWith('..' + path.sep)) {
      res.writeHead(400); res.end('bad path'); return
    }
    const stat = fs.statSync(full, { throwIfNoEntry: false })
    if (!stat || !stat.isFile()) { res.writeHead(404); res.end('not found'); return }
    const stream = fs.createReadStream(full)
    stream.on('error', () => { res.destroy() })
    const name = path.basename(full)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(name),
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    })
    stream.pipe(res)
    return
  }

  // ============ 系统信息 / 管理 API / 剪贴板 API ============

  // GET /api/info  公共（不限 localhost）
  if (req.url === '/api/info') {
    respondJSON(res, 200, {
      success: true,
      data: {
        port: PORT,
        localIPs: getLocalIPs(),
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        nodeVersion: process.version,
        permissions: permissions,
      },
    })
    return
  }

  // GET /api/client-info  当前请求来源信息
  if (req.url === '/api/client-info') {
    respondJSON(res, 200, {
      success: true,
      data: {
        ip: req.socket.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
        host: req.headers.host || '',
        isLocalhost: isLocalhost(req),
      },
    })
    return
  }

  // GET /api/admin/status  仅 localhost
  if (req.url === '/api/admin/status') {
    if (!isLocalhost(req)) { forbid(res, '仅限本机访问'); return }
    respondJSON(res, 200, {
      success: true,
      data: { permissions: permissions, clipboards: clipboards },
    })
    return
  }

  // POST /api/admin/permission  仅 localhost，body: { name, value }
  if (req.method === 'POST' && req.url === '/api/admin/permission') {
    if (!isLocalhost(req)) { forbid(res, '仅限本机访问'); return }
    readJsonBody(req).then((data) => {
      const name = String(data.name || '')
      const value = !!data.value
      if (!(name in permissions)) { respondJSON(res, 400, { success: false, message: '未知权限' }); return }
      permissions[name] = value
      sseBroadcast('permission', permissions)
      respondJSON(res, 200, { success: true, data: { name, value, permissions } })
    }).catch(() => respondJSON(res, 400, { success: false, message: '请求体错误' }))
    return
  }

  // GET /api/clipboard/:slot
  if (req.url.startsWith('/api/clipboard/')) {
    if (!permissions.clipboard) { forbid(res, '剪贴板功能已被禁用'); return }
    const slot = req.url.slice('/api/clipboard/'.length).split('?')[0]
    if (!Object.prototype.hasOwnProperty.call(clipboards, slot)) { respondJSON(res, 400, { success: false, message: '未知 slot' }); return }
    respondJSON(res, 200, { success: true, data: { slot, ...clipboards[slot] } })
    return
  }

  // POST /api/clipboard/:slot  body: { text }
  if (req.method === 'POST' && req.url.startsWith('/api/clipboard/')) {
    if (!permissions.clipboard) { forbid(res, '剪贴板功能已被禁用'); return }
    const slot = req.url.slice('/api/clipboard/'.length).split('?')[0]
    if (!Object.prototype.hasOwnProperty.call(clipboards, slot)) { respondJSON(res, 400, { success: false, message: '未知 slot' }); return }
    readJsonBody(req).then((data) => {
      const text = String(data.text || '').slice(0, 20000)
      clipboards[slot] = { text: text, time: Date.now() }
      sseBroadcast('clipboard', { slot, text, time: clipboards[slot].time })
      respondJSON(res, 200, { success: true, data: { slot, time: clipboards[slot].time } })
    }).catch(() => respondJSON(res, 400, { success: false, message: '请求体错误' }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('404 Not Found')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('=======================================================')
    console.log('  端口 ' + PORT + ' 已被占用，请先关闭占用该端口的程序后重试')
    console.log('  查询占用进程: netstat -ano | findstr :' + PORT)
    console.log('=======================================================')
  } else {
    console.log('  启动失败: ' + err.message)
  }
})

server.listen(PORT, HOST, () => {
  console.log('=======================================================')
  console.log('  LanBridge')
  console.log('  Server started')
  console.log('')
  // SEA 模式预加载 index.html，启动即能发现 asset 缺失问题
  if (isSea()) {
    readIndexHTML().then(b => {
      console.log('  [SEA] index.html asset size=' + b.length + ' bytes')
    }).catch(e => {
      console.log('  [SEA] index.html asset 加载失败: ' + e.message)
    })
  }
  console.log('  Local:   http://localhost:' + PORT)
  const ips = getLocalIPs()
  if (ips.length > 0) {
    for (const ip of ips) {
      console.log('  LAN:     http://' + ip.address + ':' + PORT + '  (' + ip.name + ')')
    }
  } else {
    console.log('  LAN:     (no LAN IP detected)')
  }
  console.log('  Share:   ' + SHARE_DIR)
  console.log('  Chat:    ' + CHAT_IMG_DIR)
  console.log('')
  console.log('  Tip: do NOT click URLs in this window - right-click to copy,')
  console.log('       or open browser and type the address manually.')
  console.log('       Press Ctrl+C in this window to stop the server.')
  console.log('  提示: VM 网络需为桥接模式；Windows 防火墙若拦截请放行端口 ' + PORT)
  console.log('=======================================================')
})
