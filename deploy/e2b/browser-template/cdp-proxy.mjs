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
    // Booking-style sites fingerprint the default headless build; this removes
    // the AutomationControlled signal alongside Playwright's own init scripts.
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--lang=en-US',
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

// Chromium advertises its websocket endpoint as ws://127.0.0.1:9222/... which
// is meaningless to a remote client (Playwright would dial its own localhost).
// Rewrite it to the public host this request arrived on, so connectOverCDP
// follows a reachable wss:// URL. The public hostname embeds the port
// (e.g. 9223-<id>.e2b.app), so the edge routes it back here.
//
// Playwright fetches `<endpoint>/json/version/` WITH a trailing slash (it
// appends "json/version/" to the endpoint path), so match every /json* path
// instead of an exact set. Missing this made Playwright read the raw
// ws://127.0.0.1:9222 URL and dial its own localhost.
function isDiscoveryPath(url) {
  return /^\/json(\/|$)/.test((url || '').split('?')[0])
}

const server = http.createServer((req, res) => {
  const publicHost = (req.headers.host || '').split(':')[0]
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      // Chromium rejects DevTools requests whose Host is not localhost/an IP;
      // keep the port so any relative ws:// URL it builds still carries 9222.
      headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` },
    },
    (up) => {
      const rewrite = isDiscoveryPath(req.url) && publicHost
      if (!rewrite) {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
        return
      }
      const chunks = []
      up.on('data', (c) => chunks.push(c))
      up.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').replace(/ws:\/\/127\.0\.0\.1(?::\d+)?/g, `wss://${publicHost}`)
        const headers = { ...up.headers }
        delete headers['content-length']
        headers['content-length'] = Buffer.byteLength(body)
        res.writeHead(up.statusCode || 502, headers)
        res.end(body)
      })
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
    const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` }
    const raw = Object.entries(headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n')
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${raw}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  // Surface Chromium's answer to the handshake. A 101 means the proxy is not
  // the problem; anything else (e.g. 403 from --remote-allow-origins) would
  // otherwise be an opaque "WebSocket error" on the client.
  let logged = false
  upstream.on('data', (chunk) => {
    if (logged || !chunk.length) return
    logged = true
    const end = chunk.indexOf(0x0a)
    const line = chunk.toString('utf8', 0, end === -1 ? chunk.length : end).trim()
    console.log(`[cdp-proxy] upgrade ${req.url} -> upstream ${line}`)
  })
  upstream.on('error', () => socket.destroy())
  upstream.on('close', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
})

server.listen(LISTEN_PORT, '0.0.0.0')
