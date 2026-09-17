import { useEffect, useRef, type RefObject } from 'react'
import { SwipeGesture } from './swipeBack'

/* Anything the finger is already editing or panning keeps the gesture: a
 * selected word, a field, or a surface that scrolls sideways on its own. */
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'

/** True when the app itself handles this element's horizontal drags — a
 * horizontal scroller, a pannable canvas (`touch-action` that leaves out
 * pan-x), or a surface that opted out by hand. */
function ownsHorizontalDrag(target: EventTarget | null): boolean {
  const start = target instanceof Element ? target : null
  if (!start) return true
  if (start.closest(EDITABLE)) return true
  if (start.closest('[data-swipe-back="off"]')) return true
  const selection = window.getSelection?.()
  if (selection && !selection.isCollapsed) return true
  for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
    const style = window.getComputedStyle(el)
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      el.scrollWidth > el.clientWidth + 4
    ) {
      return true
    }
    if (style.touchAction === 'none' || style.touchAction === 'pan-y') return true
  }
  return false
}

export interface SwipeBackOptions {
  /** Where a finished right-swipe goes: the previous page, or an overlay close. */
  onBack: () => void
  /** Off while a screen is doing something a swipe would interrupt. */
  enabled?: boolean
}

/**
 * Right-swipe to go back, the way the OS does it. The gesture is owned by the
 * document so it works anywhere on the screen, including over an open sheet,
 * and the returned ref paints the pull hint: attach it to an element carrying
 * the `swipe-back-hint` class.
 */
export function useSwipeBack({ onBack, enabled = true }: SwipeBackOptions): RefObject<HTMLDivElement | null> {
  const hintRef = useRef<HTMLDivElement | null>(null)
  const back = useRef(onBack)
  const live = useRef(enabled)

  // The gesture outlives any one render, so the handler reads the current
  // callback and flag instead of re-binding the listeners on every render.
  useEffect(() => {
    back.current = onBack
    live.current = enabled
  }, [onBack, enabled])

  useEffect(() => {
    const gesture = new SwipeGesture()

    const paint = (progress: number, swiping: boolean) => {
      const el = hintRef.current
      if (!el) return
      el.style.setProperty('--swipe-p', progress.toFixed(3))
      if (swiping) el.dataset.swiping = '1'
      else delete el.dataset.swiping
    }

    const onStart = (e: TouchEvent) => {
      if (!live.current || e.touches.length !== 1) {
        gesture.cancel()
        paint(0, false)
        return
      }
      const touch = e.touches[0]
      if (ownsHorizontalDrag(touch.target)) {
        gesture.cancel()
        return
      }
      gesture.start(touch.clientX, touch.clientY, e.timeStamp)
      paint(0, true)
    }

    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      const phase = gesture.move(touch.clientX, touch.clientY)
      paint(gesture.progress, phase !== 'cancelled')
    }

    const onEnd = (e: TouchEvent) => {
      const commit = gesture.end(e.timeStamp)
      if (commit) {
        // Hold the hint at full pull; hiding it is what the fade-out animates.
        paint(1, true)
        requestAnimationFrame(() => paint(1, false))
        back.current()
        return
      }
      paint(0, false)
    }

    const onCancel = () => {
      gesture.cancel()
      paint(0, false)
    }

    const opts = { passive: true, capture: true } as const
    document.addEventListener('touchstart', onStart, opts)
    document.addEventListener('touchmove', onMove, opts)
    document.addEventListener('touchend', onEnd, opts)
    document.addEventListener('touchcancel', onCancel, opts)
    return () => {
      document.removeEventListener('touchstart', onStart, opts)
      document.removeEventListener('touchmove', onMove, opts)
      document.removeEventListener('touchend', onEnd, opts)
      document.removeEventListener('touchcancel', onCancel, opts)
    }
  }, [])

  return hintRef
}
