export type MiniTheme = 'dark' | 'light'

const KEY = 'mini-theme'

/** Read this device's saved mini-app theme. Defaults to the charcoal dark. */
export function readMiniTheme(): MiniTheme {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'dark'
  } catch {
    return 'dark'
  }
}

/** Save the choice on this device and repaint immediately. */
export function writeMiniTheme(theme: MiniTheme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* Private mode: the choice just does not survive a reload. */
  }
  applyMiniTheme(theme)
}

/**
 * Paint now, before or after React mounts. The attribute drives both the CSS
 * vars and the shell's pre-paint body background. Null clears it, handing the
 * page back to whatever stylesheet owns the body.
 */
export function applyMiniTheme(theme: MiniTheme | null) {
  if (theme === 'light') document.documentElement.dataset.miniTheme = 'light'
  else delete document.documentElement.dataset.miniTheme
}
