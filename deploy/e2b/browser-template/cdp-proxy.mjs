// CDP proxy + Chromium supervisor for the HireAlpha sandbox template.
//
// Two jobs in one supervised process (E2B reaps background jobs when the
// start command's foreground process changes, so chromium must be OUR child):
//
//  1. Spawn Chromium headless with a localhost-only DevTools port.
//  2. Listen on 9223 and forward traffic to it, rewriting Host to 127.0.0.1
//     (Chromium's DevTools endpoint rejects any other Host: "Host header is
//     specified and is not an IP address or localhost"). Plain HTTP
//     (/json/*) and WebSocket upgrades (/devtools/*) both pass through.
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'

const UPSTREAM_PORT = 9222
const LISTEN_PORT = 9223

const chromium = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${UPSTREAM_PORT}`,
    '--remote-allow-origins=*',
    '--user-data-dir=/tmp/chrome-profile',
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
)
chromium.on('exit', (code) => {
  console.error(`[cdp-proxy] chromium exited with ${code}; exiting so the sandbox reports the failure`)
  process.exit(code ?? 1)
})

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
