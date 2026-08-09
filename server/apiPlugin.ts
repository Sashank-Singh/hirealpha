import { AGENTS, getAgent, toChatMessages, type AgentId, type Msg } from '../src/agents'
import { runAgent } from '../src/agents/runtime'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    let val = trimmed.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

async function readJson(req: Connect.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

export function hirealphaApiPlugin(): Plugin {
  loadEnvFile()

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next()

    res.setHeader('Content-Type', 'application/json')

    try {
      if (req.method === 'GET' && req.url === '/api/agents') {
        const payload = AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          imsgName: a.imsgName,
          role: a.role,
          phoneNumber: a.phoneNumber,
          phoneDisplay: a.phoneDisplay,
          color: a.color,
          pitch: a.pitch,
          behavior: a.behavior,
          systemPrompt: a.systemPrompt,
        }))
        res.end(JSON.stringify({ agents: payload }))
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/api/agents/')) {
        const id = req.url.split('/').pop() as AgentId
        const agent = getAgent(id)
        res.end(JSON.stringify({ agent }))
        return
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        const body = (await readJson(req)) as {
          agentId?: AgentId
          messages?: Msg[]
          connectedApps?: string[]
        }

        if (!body.agentId || !Array.isArray(body.messages)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'agentId and messages are required' }))
          return
        }

        const result = await runAgent({
          agentId: body.agentId,
          messages: toChatMessages(body.messages),
          connectedApps: body.connectedApps ?? [],
          apiKey:
            process.env.GMI_API_KEY ||
            process.env.OPENAI_API_KEY ||
            process.env.HIREALPHA_API_KEY,
          baseUrl:
            process.env.GMI_BASE_URL ||
            process.env.OPENAI_BASE_URL ||
            'https://api.gmi-serving.com/v1',
          model:
            process.env.GMI_MODEL ||
            process.env.HIREALPHA_MODEL ||
            'deepseek-ai/DeepSeek-V4-Flash-0731',
        })

        res.end(JSON.stringify(result))
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      res.statusCode = 500
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Server error',
        }),
      )
    }
  }

  return {
    name: 'hirealpha-api',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}
