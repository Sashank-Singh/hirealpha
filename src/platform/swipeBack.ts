/**
 * The maths behind the swipe-back gesture: which touch is a back swipe, when it
 * is far enough to count, and how far along it is for the on-screen hint. Free
 * of the DOM so the rules can be read and tested on their own.
 */

export type SwipePhase = 'idle' | 'undecided' | 'horizontal' | 'cancelled'

/** Where a finished right-swipe lands. */
export type SwipeBackTarget =
  /** The mail sheet is up: closing it is the back step. */
  | { kind: 'mail' }
  /** Settings is up. */
  | { kind: 'sheet' }
  /** The screen the user came from. */
  | { kind: 'history' }
  /** Nothing behind this card — a texted link opens the webview at index 0 —
   * so it lands on the persona's home instead of nowhere. */
  | { kind: 'home'; href: string }

export function swipeBackTarget(opts: {
  mailOpen: boolean
  sheetOpen: boolean
  /** `window.history.state.idx`: 0 when this card is the first thing the webview
   * loaded, which is the case for every link opened from a text. */
  historyIdx: number
  homeHref: string
}): SwipeBackTarget {
  if (opts.mailOpen) return { kind: 'mail' }
  if (opts.sheetOpen) return { kind: 'sheet' }
  if (opts.historyIdx > 0) return { kind: 'history' }
  return { kind: 'home', href: opts.homeHref }
}

export interface SwipeConfig {
  /** Finger travel, in px, that commits the gesture on release. */
  commitPx: number
  /** A flick commits at a shorter distance than a slow drag. */
  flickPx: number
  /** ...as long as the finger was moving this long. */
  flickMs: number
  /** Horizontal once |dx| beats |dy| by this factor — and stays horizontal only
   * while it keeps beating it. */
  axisRatio: number
  /** Movement under this is too small to pick an axis from. */
  slopPx: number
}

export const SWIPE_DEFAULTS: SwipeConfig = {
  commitPx: 72,
  flickPx: 40,
  flickMs: 260,
  axisRatio: 1.4,
  slopPx: 10,
}

export class SwipeGesture {
  private phase: SwipePhase = 'idle'
  private x0 = 0
  private y0 = 0
  private t0 = 0
  private dx = 0
  private readonly cfg: SwipeConfig

  constructor(cfg: SwipeConfig = SWIPE_DEFAULTS) {
    this.cfg = cfg
  }

  /** One finger down. Multitouch and touches we do not own never get here. */
  start(x: number, y: number, t: number): void {
    this.phase = 'undecided'
    this.x0 = x
    this.y0 = y
    this.t0 = t
    this.dx = 0
  }

  /** Finger moved. Returns the phase after this sample. */
  move(x: number, y: number): SwipePhase {
    if (this.phase === 'idle' || this.phase === 'cancelled') return this.phase
    this.dx = x - this.x0
    const dy = y - this.y0
    if (this.phase === 'undecided') {
      if (Math.abs(this.dx) < this.cfg.slopPx && Math.abs(dy) < this.cfg.slopPx) return this.phase
      // Rightward and mostly flat. Anything else is a scroll, a text selection,
      // or a leftward swipe that belongs to somebody else.
      this.phase =
        this.dx > 0 && Math.abs(this.dx) >= Math.abs(dy) * this.cfg.axisRatio ? 'horizontal' : 'cancelled'
      return this.phase
    }
    // Already horizontal: lose it if the finger turns back or dives into a
    // scroll, so a diagonal scroll never lands as a back swipe.
    if (this.dx <= 0 || Math.abs(dy) > Math.abs(this.dx) * this.cfg.axisRatio) {
      this.phase = 'cancelled'
    }
    return this.phase
  }

  /** 0–1 toward the commit distance, for the hint. */
  get progress(): number {
    if (this.phase !== 'horizontal') return 0
    return Math.max(0, Math.min(1, this.dx / this.cfg.commitPx))
  }

  get isHorizontal(): boolean {
    return this.phase === 'horizontal'
  }

  /** Finger up. True when the gesture should go back. */
  end(t: number): boolean {
    const commit =
      this.phase === 'horizontal' &&
      (this.dx >= this.cfg.commitPx || (this.dx >= this.cfg.flickPx && t - this.t0 <= this.cfg.flickMs))
    this.phase = 'idle'
    this.dx = 0
    return commit
  }

  /** The gesture ended without us — a second finger, a cancelled touch. */
  cancel(): void {
    this.phase = 'idle'
    this.dx = 0
  }
}
