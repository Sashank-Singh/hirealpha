import { readFile, rm } from 'node:fs/promises'
import type { SQL } from 'bun'
import { isPersona } from '../personas'
import { json, appBase } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { resolveAuthedUser } from '../auth/session'
import { gateWorkshopCode, runWorkshopCode, artifactDirFor } from '../workshop'

export type WorkshopRouteDeps = {
  internalOk: (req: Request) => boolean
}

export async function storeArtifactFiles(
  sql: SQL,
  userId: string,
  artifactId: string,
  files: Array<{ name: string; bytes: Uint8Array }>,
) {
  for (const f of files) {
    await sql`
      INSERT INTO hire_artifact_files (artifact_id, name, content)
      VALUES (${artifactId}, ${f.name}, ${Buffer.from(f.bytes).toString('base64')})
      ON CONFLICT (artifact_id, name) DO UPDATE SET content = excluded.content
    `
  }
}

export async function deleteArtifactRow(
  sql: SQL,
  userId: string,
  artifactId: string | undefined,
  persona: string,
) {
  let id = artifactId
  if (!id) {
    const rows = await sql`
      SELECT id FROM hire_artifacts
      WHERE user_id = ${userId} AND state = 'delivered'
      ORDER BY created_at DESC LIMIT 1
    `
    id = (rows[0] as { id?: string } | undefined)?.id
  }
  if (!id) return { ok: false, logged: false, error: 'No delivered artifact found' }
  const owned = await sql`
    SELECT id FROM hire_artifacts WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `
  if (!owned[0]) return { ok: false, logged: false, error: 'No delivered artifact found' }
  await sql`DELETE FROM hire_artifact_files WHERE artifact_id = ${id}`
  await rm(artifactDirFor(userId, id), { recursive: true, force: true })
  await sql`DELETE FROM hire_artifacts WHERE id = ${id} AND user_id = ${userId}`
  void persona
  return { ok: true, logged: true, id }
}

const gonePage = (msg: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gone</title><style>body{background:#0c0e11;color:#98a0ab;font-family:-apple-system,'Helvetica Neue',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}p{padding:0 32px}</style></head><body><p>${msg}</p></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )

export async function handleWorkshopRoutes(
  req: Request,
  sql: SQL,
  deps: WorkshopRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (
    !path.startsWith('/api/internal/workshop') &&
    !path.startsWith('/api/artifacts') &&
    !path.startsWith('/b/') &&
    !path.startsWith('/a/')
  ) {
    return null
  }

  if (path === '/api/internal/workshop/count' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const rows = (await sql`
      SELECT state, count(*)::int AS n FROM hire_artifacts GROUP BY state
    `) as Array<{ state: string; n: number }>
    const byState: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      byState[r.state] = r.n
      total += r.n
    }
    return json({ total, byState })
  }

  if (path === '/api/internal/workshop' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    if (process.env.WORKSHOP_ENABLED === '0') return json({ ok: false, logged: false, error: 'Workshop is disabled' })
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; prompt?: string; title?: string; code?: string; templateKey?: string
    }
    const code = String(body.code || '')
    const prompt = String(body.prompt || '').trim().slice(0, 500)
    const templateKey = String(body.templateKey || '').trim().slice(0, 60) || null
    if (!body.phone || !isPersona(body.persona || '') || !code) {
      return json({ error: 'phone, persona, and code required' }, 400)
    }
    try {
      // Schema guard: a build must never 500 on missing tables after a fresh
      // deploy — both creates are idempotent and cost nothing once warm.
      await sql`
        CREATE TABLE IF NOT EXISTS hire_artifact_files (
          artifact_id TEXT NOT NULL REFERENCES hire_artifacts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          PRIMARY KEY (artifact_id, name)
        )
      `
      const user = await getUserByPhone(sql, body.phone)
      if (!user) return json({ error: 'User not found' }, 404)
      // Rate limit: ten finished builds a day is generous for a human and a
      // floor on abuse. Failed attempts (no artifact) don't consume quota —
      // otherwise a debugging session locks the builder for the day.
      const used = await sql`
        SELECT count(*)::int AS n FROM hire_workshop_tasks
        WHERE user_id = ${user.id} AND created_at >= date_trunc('day', now())
          AND artifact_id IS NOT NULL
      `
      if (Number((used[0] as { n?: number })?.n || 0) >= 10) {
        return json({ ok: false, logged: false, error: 'Build limit reached for today (10).' })
      }
      await sql`INSERT INTO hire_workshop_tasks (id, user_id, prompt, status) VALUES (${crypto.randomUUID()}, ${user.id}, ${prompt || 'build'}, 'running')`
      const gate = gateWorkshopCode(code)
      if (!gate.ok) {
        await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${gate.reason} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
        return json({ ok: false, logged: false, error: gate.reason })
      }
      const run = await runWorkshopCode(code)
      if (!run.ok || !run.files.length) {
        const error = run.error || 'The program produced no files.'
        await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${error.slice(0, 500)} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
        return json({ ok: false, logged: false, error: error.slice(0, 300) })
      }
      // The sandbox only proves the wrapper ran — the app's inline JavaScript
      // was never executed. The model loves unescaped apostrophes ('Time's
      // up!'), which kill the whole script: page renders, every button dead.
      // Parse-check every inline block; a failure feeds the repair pass.
      const htmlFile = run.files.find((f) => /\.html?$/i.test(f.name))
      if (htmlFile) {
        const builtHtml = Buffer.from(htmlFile.bytes).toString('utf8')
        const inlineScripts = [...builtHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((m) => m[1])
          .filter((s) => s.trim())
        for (const inline of inlineScripts) {
          try {
            // Parse-only (never executes): the transpiler throws on syntax
            // errors without running a single line of app code.
            new Bun.Transpiler({ loader: 'js' }).transformSync(inline)
          } catch (e) {
            const msg = `the app's JavaScript does not parse: ${(e as Error).message}`.slice(0, 300)
            await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${msg} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
            return json({ ok: false, logged: false, error: msg })
          }
        }
      }
      const artifactId = crypto.randomUUID()
      const title = String(body.title || prompt || 'Built for you').slice(0, 120)
      // Parent row first: the file rows FK-reference hire_artifacts, so storing
      // files before the artifact exists violates the key and kills the build.
      const fileNames = run.files.map((f) => f.name)
      const expires = new Date(Date.now() + 7 * 86_400_000)
      await sql`
        INSERT INTO hire_artifacts (id, user_id, title, kind, files, state, expires_at, template_key)
        VALUES (${artifactId}, ${user.id}, ${title}, ${fileNames.some((f) => /\.html?$/i.test(f)) ? 'page' : 'file'},
          ${JSON.stringify(fileNames)}, 'delivered', ${expires.toISOString()}, ${templateKey})
      `
      await storeArtifactFiles(sql, user.id, artifactId, run.files)
      await sql`
        UPDATE hire_workshop_tasks SET status = 'done', artifact_id = ${artifactId}
        WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'
      `
      return json({
        ok: true,
        logged: true,
        artifactId,
        title,
        files: fileNames,
        url: `${appBase(req)}/b/${artifactId}`,
      })
    } catch (err) {
      // Never a bare 500: the bot quotes this error back to the user, and the
      // stack lands in the container log for the real fix.
      console.error('[workshop] endpoint threw', err)
      return json({
        ok: false,
        logged: false,
        error: `server error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      })
    }
  }

  if (path === '/api/internal/workshop/find' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const key = (url.searchParams.get('key') || '').trim()
    if (!phone || !key) return json({ artifact: null })
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ artifact: null })
    const rows = await sql`
      SELECT id, title FROM hire_artifacts
      WHERE template_key = ${key} AND user_id != ${user.id} AND state IN ('delivered', 'kept')
      ORDER BY created_at DESC LIMIT 1
    `
    const row = rows[0] as { id: string; title: string } | undefined
    return json({ artifact: row ? { artifactId: row.id, title: row.title } : null })
  }

  if (path === '/api/internal/workshop/clone' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; artifactId?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !body.artifactId) {
      return json({ error: 'phone, persona, and artifactId required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const src = await sql`
      SELECT title, kind, files, template_key FROM hire_artifacts
      WHERE id = ${body.artifactId} AND state IN ('delivered', 'kept') LIMIT 1
    `
    const source = src[0] as { title: string; kind: string; files: string[] | string; template_key?: string } | undefined
    if (!source) return json({ ok: false, logged: false, error: 'source build no longer exists' })
    let fileList: string[] = []
    try {
      fileList = Array.isArray(source.files) ? source.files : JSON.parse(String(source.files || '[]'))
    } catch {
      fileList = []
    }
    const cloneId = crypto.randomUUID()
    const expires = new Date(Date.now() + 7 * 86_400_000)
    await sql`
      INSERT INTO hire_artifacts (id, user_id, title, kind, files, state, expires_at, template_key)
      VALUES (${cloneId}, ${user.id}, ${source.title}, ${source.kind},
        ${JSON.stringify(fileList)}, 'delivered', ${expires.toISOString()}, ${source.template_key || null})
    `
    const fileRows = await sql`
      SELECT name, content FROM hire_artifact_files WHERE artifact_id = ${body.artifactId}
    `
    for (const f of fileRows as Array<{ name: string; content: string }>) {
      await sql`
        INSERT INTO hire_artifact_files (artifact_id, name, content)
        VALUES (${cloneId}, ${f.name}, ${f.content})
        ON CONFLICT (artifact_id, name) DO UPDATE SET content = excluded.content
      `
    }
    await sql`
      INSERT INTO hire_workshop_tasks (id, user_id, prompt, status, artifact_id)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${('shared: ' + source.title).slice(0, 500)}, 'done', ${cloneId})
    `
    return json({
      ok: true,
      logged: true,
      artifactId: cloneId,
      title: source.title,
      deduped: true,
      files: fileList,
      url: `${appBase(req)}/b/${cloneId}`,
    })
  }

  if (path === '/api/internal/workshop/source' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const artifactId = url.searchParams.get('artifactId') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = artifactId
      ? await sql`SELECT id, title, files, template_key FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user.id} AND state IN ('delivered', 'kept') LIMIT 1`
      : await sql`SELECT id, title, files, template_key FROM hire_artifacts WHERE user_id = ${user.id} AND state IN ('delivered', 'kept') ORDER BY created_at DESC LIMIT 1`
    const row = rows[0] as { id: string; title: string; files: string[] | string; template_key: string | null } | undefined
    if (!row) return json({ error: 'No build on file' }, 404)
    let fileList: string[] = []
    try {
      fileList = Array.isArray(row.files) ? row.files : JSON.parse(String(row.files || '[]'))
    } catch {
      fileList = []
    }
    const htmlName = fileList.find((f) => /\.html?$/i.test(f)) || fileList[0] || ''
    const fileRows = await sql`
      SELECT content FROM hire_artifact_files WHERE artifact_id = ${row.id} AND name = ${htmlName} LIMIT 1
    `
    const content = (fileRows[0] as { content?: string } | undefined)?.content
    if (!content) return json({ error: 'Build file missing' }, 404)
    return json({
      artifactId: row.id,
      title: row.title,
      templateKey: row.template_key,
      html: Buffer.from(content, 'base64').toString('utf8'),
    })
  }

  if (path === '/api/internal/workshop/iterate' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; artifactId?: string; title?: string; html?: string; instruction?: string
    }
    const html = String(body.html || '')
    const artifactId = String(body.artifactId || '')
    if (!body.phone || !isPersona(body.persona || '') || !artifactId || !html) {
      return json({ error: 'phone, persona, artifactId, and html required' }, 400)
    }
    try {
      const user = await getUserByPhone(sql, body.phone)
      if (!user) return json({ error: 'User not found' }, 404)
      const srcRows = await sql`
        SELECT title, template_key, state, expires_at FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user.id} LIMIT 1
      `
      const src = srcRows[0] as { title: string; template_key: string | null; state: string; expires_at: Date | null } | undefined
      if (!src) return json({ ok: false, logged: false, error: 'source build no longer exists' })
      // Same inline-JS parse gate as fresh builds: dead buttons never ship.
      const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1])
        .filter((s) => s.trim())
      for (const inline of inlineScripts) {
        try {
          new Bun.Transpiler({ loader: 'js' }).transformSync(inline)
        } catch (e) {
          return json({ ok: false, logged: false, error: `the updated app's JavaScript does not parse: ${(e as Error).message}`.slice(0, 300) })
        }
      }
      const title = String(body.title || src.title).slice(0, 120)
      const inheritKept = src.state === 'kept'
      const expires = new Date(Date.now() + 7 * 86_400_000)
      await sql`
        UPDATE hire_artifacts
        SET title = ${title},
            state = ${inheritKept ? 'kept' : 'delivered'},
            expires_at = ${inheritKept ? null : expires.toISOString()},
            files = ${JSON.stringify(['index.html'])}
        WHERE id = ${artifactId} AND user_id = ${user.id}
      `
      await sql`
        DELETE FROM hire_artifact_files WHERE artifact_id = ${artifactId} AND name = 'index.html'
      `
      await sql`
        INSERT INTO hire_artifact_files (artifact_id, name, content)
        VALUES (${artifactId}, 'index.html', ${Buffer.from(html).toString('base64')})
      `
      await sql`
        INSERT INTO hire_workshop_tasks (id, user_id, prompt, status, artifact_id)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${('iterate: ' + String(body.instruction || '')).slice(0, 500)}, 'done', ${artifactId})
      `
      return json({
        ok: true,
        logged: true,
        artifactId,
        title,
        url: `${appBase(req)}/b/${artifactId}`,
      })
    } catch (err) {
      console.error('[workshop] iterate threw', err)
      return json({ ok: false, logged: false, error: `server error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) })
    }
  }

  if (path === '/api/internal/workshop/last' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const user = await getUserByPhone(sql, url.searchParams.get('phone') || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = await sql`
      SELECT id, title, state, expires_at AS "expiresAt" FROM hire_artifacts
      WHERE user_id = ${user.id} AND state = 'delivered'
      ORDER BY created_at DESC LIMIT 1
    `
    const row = rows[0] as { id: string; title: string; state: string; expiresAt: Date } | undefined
    return json({ artifact: row ? { id: row.id, title: row.title, expiresAt: row.expiresAt } : null })
  }

  if (path === '/api/internal/workshop/tasks' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const rows = await sql`
      SELECT t.prompt, t.status, t.error, t.created_at AS "createdAt"
      FROM hire_workshop_tasks t
      ${phone ? sql`JOIN hire_users u ON u.id = t.user_id WHERE u.phone_e164 = ${phone}` : sql``}
      ORDER BY t.created_at DESC LIMIT 10
    `
    return json({ tasks: rows })
  }

  if (path === '/api/internal/workshop/keep' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; artifactId?: string }
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const result = await (async () => {
      const id = body.artifactId
      if (id) {
        const kept = (await sql`
          UPDATE hire_artifacts SET state = 'kept', expires_at = NULL
          WHERE id = ${id} AND user_id = ${user.id} RETURNING id
        `) as Array<{ id: string }>
        if (!kept.length) return { ok: false, logged: false, error: 'That build is no longer on file, so nothing was kept.' }
        return { ok: true, logged: true, id }
      }
      const rows = await sql`
        SELECT id FROM hire_artifacts WHERE user_id = ${user.id} AND state = 'delivered'
        ORDER BY created_at DESC LIMIT 1
      `
      const latest = (rows[0] as { id?: string } | undefined)?.id
      if (!latest) return { ok: false, logged: false, error: 'Nothing to keep' }
      const keptLatest = (await sql`
        UPDATE hire_artifacts SET state = 'kept', expires_at = NULL
        WHERE id = ${latest} AND user_id = ${user.id} RETURNING id
      `) as Array<{ id: string }>
      if (!keptLatest.length) return { ok: false, logged: false, error: 'Nothing to keep' }
      return { ok: true, logged: true, id: latest }
    })()
    return json(result)
  }

  if (path === '/api/internal/workshop/toss' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; artifactId?: string }
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await deleteArtifactRow(sql, user.id, body.artifactId, body.persona || ''))
  }

  if (path === '/api/artifacts' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, kind, files, state, expires_at AS "expiresAt", created_at AS "createdAt"
      FROM hire_artifacts WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    return json({ artifacts: rows })
  }

  if (path === '/api/artifacts' && req.method === 'DELETE') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const id = url.searchParams.get('id') || ''
    return json(await deleteArtifactRow(sql, user!.id, id || undefined, ''))
  }

  const publicBuild = path.match(/^\/b\/([\w-]+)$/)
  if (publicBuild && req.method === 'GET') {
    try {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      const rows = await sql`
        SELECT title, files, state, expires_at AS "expiresAt" FROM hire_artifacts WHERE id = ${publicBuild[1]} LIMIT 1
      `
      const rawRow = rows[0] as { title: string; files: string[] | string; state: string; expiresAt: Date | null } | undefined
      const expired = rawRow?.expiresAt ? new Date(rawRow.expiresAt).getTime() < Date.now() : false
      if (!rawRow || rawRow.state === 'tossed' || expired) {
        return gonePage('This build is gone. Ask Alpha to build it again.')
      }
      let files: string[] = []
      try {
        files = Array.isArray(rawRow.files) ? rawRow.files : JSON.parse(String(rawRow.files || '[]'))
      } catch {
        files = []
      }
      const htmlName = files.find((f) => /\.html?$/i.test(f)) || files[0] || ''
      const fileRows = await sql`
        SELECT content FROM hire_artifact_files
        WHERE artifact_id = ${publicBuild[1]} AND name = ${htmlName} LIMIT 1
      `
      const content = (fileRows[0] as { content?: string } | undefined)?.content
      if (!content) return gonePage('This build is gone. Ask Alpha to build it again.')
      let html = Buffer.from(content, 'base64').toString('utf8')
      if (!/<meta\s+name=["']viewport["']/i.test(html)) {
        const vp = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />'
        html = html.includes('<head>') ? html.replace('<head>', `<head>${vp}`) : `${vp}${html}`
      } else if (!/viewport-fit=cover/i.test(html)) {
        html = html.replace(/(<meta\s+name=["']viewport["'][^>]*content=["'][^"']+)(["'])/i, '$1, viewport-fit=cover$2')
      }

      const safeAreaStyle = `<style id="alpha-mobile-safe-area">
  :root {
    --sat: env(safe-area-inset-top, 0px);
    --sab: env(safe-area-inset-bottom, 0px);
    --sal: env(safe-area-inset-left, 0px);
    --sar: env(safe-area-inset-right, 0px);
  }
  html {
    box-sizing: border-box;
    min-height: 100dvh;
  }
  *, *::before, *::after {
    box-sizing: inherit;
  }
  body {
    min-height: 100dvh;
    padding-top: max(16px, env(safe-area-inset-top, 0px));
    padding-bottom: max(32px, env(safe-area-inset-bottom, 0px));
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
</style>`
      if (!html.includes('id="alpha-mobile-safe-area"')) {
        html = html.includes('</head>') ? html.replace('</head>', `${safeAreaStyle}</head>`) : `${safeAreaStyle}${html}`
      }

      if (!/<meta\s+property="og:title"/i.test(html)) {
        const og = `<meta property="og:title" content="${esc(rawRow.title)}" /><meta property="og:description" content="Built by Alpha" />`
        html = html.includes('</head>') ? html.replace('</head>', `${og}</head>`) : `${og}${html}`
      }
      if (!/<title>/i.test(html)) {
        html = html.includes('<head') ? html.replace(/<head([^>]*)>/i, `<head$1><title>${esc(rawRow.title)}</title>`) : `<title>${esc(rawRow.title)}</title>${html}`
      }
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      console.error('[builds] /b/ serve failed', err)
      return gonePage('This build is gone. Ask Alpha to build it again.')
    }
  }

  const artifactFile = path.match(/^\/a\/([\w-]+)\/([\w.-]+)$/)
  if (artifactFile && req.method === 'GET') {
    const [, artifactId, fileName] = artifactFile
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT files FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user!.id} LIMIT 1
    `
    const rawRow = rows[0] as { files?: string[] | string } | undefined
    if (!rawRow) return json({ error: 'Not found' }, 404)
    let fileList: string[] = []
    try {
      fileList = Array.isArray(rawRow.files) ? rawRow.files : JSON.parse(String(rawRow.files || '[]'))
    } catch {
      fileList = []
    }
    const safeName = fileName.replace(/[\\/]/g, '')
    if (!fileList.includes(safeName)) return json({ error: 'Not found' }, 404)
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
      '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.pdf': 'application/pdf',
    }
    const type = types[safeName.slice(safeName.lastIndexOf('.'))] || 'application/octet-stream'
    const dbRows = await sql`
      SELECT content FROM hire_artifact_files
      WHERE artifact_id = ${artifactId} AND name = ${safeName}
      LIMIT 1
    `
    const dbContent = (dbRows[0] as { content?: string } | undefined)?.content
    if (dbContent) {
      return new Response(Buffer.from(dbContent, 'base64'), {
        headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
      })
    }
    try {
      const bytes = await readFile(artifactDirFor(user!.id, artifactId) + '/' + safeName)
      return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } })
    } catch {
      return json({ error: 'Not found' }, 404)
    }
  }

  const artifactGet = path.match(/^\/api\/artifacts\/([\w-]+)$/)
  if (artifactGet && req.method === 'GET') {
    const cookieSession = (req.headers.get('cookie') || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('hirealpha_session='))
      ?.slice('hirealpha_session='.length)
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || cookieSession || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, kind, files, state, expires_at AS "expiresAt"
      FROM hire_artifacts WHERE id = ${artifactGet[1]} AND user_id = ${user!.id} LIMIT 1
    `
    const row = rows[0] as
      | { id: string; title: string; kind: string; files: string[]; state: string; expiresAt: string | null }
      | undefined
    if (!row) return json({ error: 'Not found' }, 404)
    return json(row)
  }

  const artifactAction = path.match(/^\/api\/artifacts\/([\w-]+)\/(keep|delete)$/)
  if (artifactAction && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const [, id, action] = artifactAction
    if (action === 'keep') {
      await sql`UPDATE hire_artifacts SET state = 'kept', expires_at = NULL WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true, state: 'kept' })
    }
    return json(await deleteArtifactRow(sql, user!.id, id, ''))
  }

  return null
}
