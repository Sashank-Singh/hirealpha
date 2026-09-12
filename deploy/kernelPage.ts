/**
 * A Kernel cloud browser with a page-shaped surface.
 *
 * Kernel runs our Playwright code INSIDE the browser's own VM, so the agent
 * driver talks to this object instead of holding a websocket: every call is a
 * short script executed in the VM against a page that stays open between calls.
 * That removes the CDP-connection dependency entirely — which matters because
 * some networks (including the founder's laptop) cannot reach Kernel's proxy
 * port, while the API host is reachable everywhere.
 *
 * The surface deliberately mirrors the handful of Playwright page methods the
 * driver already uses, so the same agent loop runs on either backend.
 */

export type KernelPageOptions = {
  apiKey: string
  baseUrl?: string
  /** Milliseconds a launch may take before it is declared dead. */
  launchTimeoutMs?: number
}

type ExecuteResponse = {
  success: boolean
  error?: string
  result?: unknown
  stdout?: string
  stderr?: string
}

export class KernelBrowser {
  readonly sessionId: string
  readonly liveViewUrl: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private pageUrl = ''
  private closed = false

  private constructor(
    private readonly init: { sessionId: string; liveViewUrl: string; pageUrl: string },
    options: KernelPageOptions,
  ) {
    this.sessionId = init.sessionId
    this.liveViewUrl = init.liveViewUrl
    this.pageUrl = init.pageUrl
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl || 'https://api.onkernel.com').replace(/\/$/, '')
  }

  /** Launch a stealth browser. Headful is required: Kernel serves the live
   * view — the page a human solves a CAPTCHA on — only for headful sessions,
   * and an unresolved challenge must reach a person rather than die silently. */
  static async launch(options: KernelPageOptions & { profile?: string; timeoutSeconds?: number }): Promise<KernelBrowser> {
    const res = await fetch(`${options.baseUrl || 'https://api.onkernel.com'}/browsers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headless: false,
        stealth: true,
        timeout_seconds: Math.max(60, Math.min(86_400, options.timeoutSeconds ?? 600)),
        viewport: { width: 1280, height: 900 },
        ...(options.profile ? { profile: { name: options.profile, save_changes: true } } : {}),
      }),
      signal: AbortSignal.timeout(options.launchTimeoutMs ?? 60_000),
    })
    if (!res.ok) {
      throw new Error(`Kernel browser launch failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
    const body = (await res.json()) as { session_id: string; browser_live_view_url?: string }
    return new KernelBrowser(
      { sessionId: body.session_id, liveViewUrl: body.browser_live_view_url || '', pageUrl: '' },
      options,
    )
  }

  /** Run a snippet in the browser VM. `page`, `context` and `browser` are in
   * scope; the snippet's `return` value comes back as `result`. */
  async run<T = unknown>(code: string, timeoutMs = 120_000): Promise<T> {
    if (this.closed) throw new Error('Kernel browser is closed')
    const res = await fetch(`${this.baseUrl}/browsers/${this.sessionId}/playwright/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`Kernel execute failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const body = (await res.json()) as ExecuteResponse
    if (!body.success) throw new Error(body.error || 'Kernel execute failed')
    return body.result as T
  }

  // ---- The Playwright-page-shaped surface the agent driver uses ----

  async goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const wait = options?.waitUntil || 'domcontentloaded'
    const timeout = options?.timeout ?? 60_000
    await this.run(
      `await page.goto(${JSON.stringify(url)}, { waitUntil: ${JSON.stringify(wait)}, timeout: ${timeout} });`,
      timeout + 15_000,
    )
    this.pageUrl = url
  }

  url(): string {
    return this.pageUrl
  }

  /** Kernel stops billing, then reaps a session, after a few idle seconds.
   * Long model turns between captures are not "idle" to the user but they are
   * to the provider, so the loop touches the page to keep the session alive. */
  async keepalive(): Promise<void> {
    if (this.closed) return
    await this.run('return await page.evaluate(() => location.href).catch(() => null);', 20_000).catch(() => undefined)
  }

  /** Wait for the page to stop navigating. Every capture has to survive a
   * context swap, so run this after any navigation and before a screenshot. */
  async settle(timeoutMs = 20_000): Promise<void> {
    await this.run(
      `await page.waitForLoadState('domcontentloaded', { timeout: ${timeoutMs} }).catch(() => undefined);
       const deadline = Date.now() + ${timeoutMs};
       while (Date.now() < deadline) {
         try {
           const state = await page.evaluate(() => document.readyState);
           if (state === 'complete') break;
         } catch { /* navigating */ }
         await page.waitForTimeout(500);
       }`,
      timeoutMs + 10_000,
    ).catch(() => undefined)
    this.pageUrl = await this.run<string>('return page.url();', 20_000).catch(() => this.pageUrl)
  }

  async title(): Promise<string> {
    return this.run<string>('return await page.title();', 30_000)
  }

  async text(selector = 'body', max = 4000): Promise<string> {
    return this.run<string>(
      `return (await page.innerText(${JSON.stringify(selector)}).catch(() => '')).slice(0, ${max});`,
      30_000,
    )
  }

  async screenshot(quality = 50): Promise<string> {
    return this.run<string>(
      `const shot = await page.screenshot({ type: 'jpeg', quality: ${quality} }); return shot.toString('base64');`,
      60_000,
    )
  }

  /** Interactive elements the agent loop offers the model as click targets. */
  async targets(max = 60): Promise<Array<{ index: number; tag: string; label: string }>> {
    return this.run<Array<{ index: number; tag: string; label: string }>>(
      `return await page.evaluate((limit) => {
        const out = [];
        const nodes = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick]');
        for (const el of nodes) {
          if (out.length >= limit) break;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
          if (!label) continue;
          out.push({ index: out.length, tag: el.tagName.toLowerCase(), label });
        }
        return out;
      }, ${max});`,
      30_000,
    )
  }

  async click(index: number): Promise<void> {
    await this.run(
      `await page.evaluate((i) => {
        const nodes = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick]');
        const el = nodes[i];
        if (!el) throw new Error('no target at index ' + i);
        el.scrollIntoView({ block: 'center' });
        el.click();
      }, ${index});`,
      30_000,
    )
  }

  async fill(index: number, value: string): Promise<void> {
    await this.run(
      `await page.evaluate(({ i, v }) => {
        const nodes = document.querySelectorAll('input,textarea,select');
        const el = nodes[i];
        if (!el) throw new Error('no field at index ' + i);
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { i: ${index}, v: ${JSON.stringify(value)} });`,
      30_000,
    )
  }

  async press(key: string): Promise<void> {
    await this.run(`await page.keyboard.press(${JSON.stringify(key)});`, 30_000)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await fetch(`${this.baseUrl}/browsers/${this.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }).catch(() => undefined)
  }
}
