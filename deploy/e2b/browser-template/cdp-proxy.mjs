// CDP proxy for the HireAlpha sandbox template.
//
// Chromium's DevTools HTTP endpoint rejects any request whose Host header is
// not an IP or localhost ("Host header is specified and is not an IP address
// or localhost"), and the sandbox's public host is a domain — so remote
// clients cannot talk to Chromium directly. This proxy listens on 9223,
// rewrites Host to 127.0.0.1, and forwards both plain HTTP (/json/*) and
// WebSocket upgrades (/devtools/*) to Chromium on 9222.
import http from 'node:http'
import net from 'node:net'

const UPSTREAM_PORT = 9222
const LISTEN_PORT = 9223

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1' },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    res.statusCode = 502
    res.end('upstream unavailable')
  })
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(UPSTREAM_PORT, '127.0.0.1', () => {
    const headers = { ...req.headers, host: '127.0.0.1' }
    const raw = Object.entries(headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n')
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${raw}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(LISTEN_PORT, '0.0.0.0')
