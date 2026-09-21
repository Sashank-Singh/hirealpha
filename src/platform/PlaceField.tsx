import { useEffect, useId, useRef, useState } from 'react'
import { placeSearchUrl, rateLimitedPlaceSearch, type PlaceHit } from './placeSearch'
import './placeField.css'

/* An address input that suggests places as you type.
 *
 * The founder's ask, 2026-09-21, over the wizard's "Where's home?" field with an
 * address half typed: "make this recommend places when i type so i can easily
 * select my address". Before this the field was free text and the address was
 * resolved by a single `limit=1` lookup at Next, so the person never saw what
 * their words were about to become.
 *
 * Picking is the contract: `onPick(hit)` hands the parent the coordinates, and the
 * parent saves those. Typing again after a pick clears it — a picked place must
 * never outlive the words in the box, or the save would write coordinates the
 * person had already moved on from.
 */

const DEBOUNCE_MS = 450

export function PlaceField({
  value,
  onChange,
  onPick,
  placeholder,
  ariaLabel,
  autoFocus,
  inputClassName = 'setup__text',
}: {
  value: string
  onChange: (text: string) => void
  onPick: (hit: PlaceHit | null) => void
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  /** The host surface's own input class, so the field matches the page it sits
   * on (the wizard and the settings sheet style inputs differently). */
  inputClassName?: string
}) {
  const [hits, setHits] = useState<PlaceHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [searching, setSearching] = useState(false)
  // The text we last fetched for, so a pick (which rewrites the input) does not
  // immediately re-open the list with the same five rows.
  const fetchedFor = useRef('')
  const listId = useId()
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const query = value.trim()
    if (query.length < 3) {
      setHits([])
      setOpen(false)
      setSearching(false)
      return
    }
    if (query === fetchedFor.current) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const url = placeSearchUrl(query)
      if (!url) return
      setSearching(true)
      rateLimitedPlaceSearch(url, query, controller.signal)
        .then((rows) => {
          fetchedFor.current = query
          setHits(rows)
          setActive(rows.length ? 0 : -1)
          setOpen(rows.length > 0)
        })
        // A failed suggestion lookup is not an error the person needs: the typed
        // text still saves through the one-shot geocode. Silence is the right
        // outcome here, and aborting on the next keystroke is not a failure.
        .catch(() => undefined)
        .finally(() => setSearching(false))
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value])

  // Tap-away closes the list; the typed text stays.
  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent | TouchEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  function pick(hit: PlaceHit) {
    onChange(hit.label)
    onPick(hit)
    fetchedFor.current = hit.label
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && hits.length) {
      event.preventDefault()
      if (!open) setOpen(true)
      setActive((i) => (i + 1) % hits.length)
      return
    }
    if (event.key === 'ArrowUp' && hits.length) {
      event.preventDefault()
      setActive((i) => (i <= 0 ? hits.length - 1 : i - 1))
      return
    }
    if (event.key === 'Enter' && open && active >= 0 && hits[active]) {
      // Enter picks rather than submitting the whole wizard: a suggestion under
      // the cursor is what the person is looking at.
      event.preventDefault()
      pick(hits[active]!)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="placefield" ref={boxRef}>
      <input
        className={`placefield__input ${inputClassName}`}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          onChange(event.target.value)
          // Any edit invalidates a previous pick.
          onPick(null)
          if (fetchedFor.current !== event.target.value.trim()) fetchedFor.current = ''
        }}
        onFocus={() => {
          if (hits.length) setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {searching && !open && <span className="placefield__spinner" aria-hidden="true" />}
      {open && (
        <ul className="placefield__list" role="listbox" id={listId} aria-label="Place suggestions">
          {hits.map((hit, index) => (
            <li key={`${hit.lat},${hit.lon},${hit.display}`} role="none">
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`placefield__option${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                // mousedown, not click: the input blurs on mousedown and a click
                // handler can lose the race on mobile Safari.
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(hit)
                }}
              >
                <span className="placefield__option-label">{hit.label}</span>
                <span className="placefield__option-display">{hit.display}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
