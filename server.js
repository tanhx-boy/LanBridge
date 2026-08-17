// web-copy-share 静态服务（零依赖，仅 Node 内置模块）
// 启动: node server.js
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

const PORT = 24496
const HOST = '0.0.0.0'
const INDEX_FILE = path.join(__dirname, 'index.html')

// 自身文件：不出现在下载列表，也不可被下载
const SELF_FILES = new Set(['server.js', 'index.html', 'README.md'])

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

// 递归扫描目录（深度上限 3 层），返回目录树 { name, dirs: [...], files: [...] }
function scanTree(dir, depth) {
  const node = { name: path.basename(dir), dirs: [], files: [] }
  if (depth > 3) return node
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (SELF_FILES.has(entry.name)) continue
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

// 校验共享路径：仅允许项目目录内文件（支持子目录），防目录穿越
// 返回 { name: 相对路径, path: 绝对路径, size } 或 null
function resolveShareFile(name) {
  if (!name || typeof name !== 'string') return null
  const segments = name.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0) return null
  if (segments.some(s => s === '..')) return null
  if (SELF_FILES.has(segments[segments.length - 1])) return null
  const full = path.join(__dirname, ...segments)
  const rel = path.relative(__dirname, full)
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return null
  const stat = fs.statSync(full, { throwIfNoEntry: false })
  if (!stat || !stat.isFile()) return null
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

// 上传回传：PUT /upload/<相对路径>，body 流式写文件，不设大小上限
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
  const full = path.join(__dirname, ...segments)
  const rel = path.relative(__dirname, full)
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    respondJSON(res, 403, { success: false, message: '非法路径' })
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
  const fail = () => {
    if (aborted) return
    aborted = true
    ws.destroy()
    fs.unlink(full, () => {}) // 清理半成品
  }
  req.on('data', chunk => { size += chunk.length })
  req.on('error', fail)
  req.on('aborted', fail)
  ws.on('error', fail)
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
    // 实时读盘 + 禁用缓存，改完 HTML 保存后 VM 刷新即可看到新内容
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('无法读取 index.html: ' + err.message)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(data)
    })
    return
  }

  // 文件清单 API：递归目录树
  if (req.url === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ success: true, data: scanTree(__dirname, 0) }))
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

  // 下载测速：按 size=MB 生成随机字节流（单请求上限 2GB，供浏览器流式读取跑满时长）
  if (req.url.startsWith('/speedtest')) {
    const mb = Math.min(Math.max(parseInt(new URL(req.url, 'http://x').searchParams.get('size') || '8', 10) || 8, 1), 2048)
    const size = mb * 1024 * 1024
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': size,
    })
    res.on('error', () => { /* 客户端断开时忽略 */ })
    let sent = 0
    const CHUNK = 256 * 1024
    const writeNext = () => {
      while (sent < size) {
        const n = Math.min(CHUNK, size - sent)
        if (!res.write(crypto.randomBytes(n))) {
          res.once('drain', writeNext)
          return
        }
        sent += n
      }
      res.end()
    }
    writeNext()
    return
  }

  // 上传测速：接收请求体，丢弃并统计字节数（上限 500MB）
  if (req.url === '/upload-test') {
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
    handleUpload(req, res, req.url.slice('/upload/'.length))
    return
  }

  // 在线预览：GET /preview/<路径>
  if (req.url.startsWith('/preview/')) {
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
  console.log('  正文复制网页已启动（零依赖）')
  console.log('  本机访问:  http://localhost:' + PORT)
  const ips = getLocalIPs()
  if (ips.length > 0) {
    console.log('  虚拟机访问: 请在 VM 浏览器打开以下地址之一:')
    for (const ip of ips) {
      console.log('    http://' + ip.address + ':' + PORT + '  (' + ip.name + ')')
    }
  } else {
    console.log('  (未检测到局域网 IP，请确认网卡已连接网络)')
  }
  console.log('  提示: VM 网络需为桥接模式；Windows 防火墙若拦截请放行端口 ' + PORT)
  console.log('=======================================================')
})
