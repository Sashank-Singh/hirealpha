import { useState } from 'react'
import {
  REMINDER_CATEGORIES,
  type ProactiveSettings,
} from './onboarding'

export function ProactiveControls({
  value,
  onChange,
  full = false,
}: {
  value: ProactiveSettings
  onChange: (next: ProactiveSettings) => void
  full?: boolean
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewLine =
    value.everythingOff || !value.enabled
      ? 'Proactive messages are paused. Nothing will be sent.'
      : value.checkInFrequency === 'off'
        ? 'Check-ins are off. You will not get proactive messages.'
        : `Next scheduled message: a light check-in (${value.checkInFrequency === 'daily' ? 'today' : 'this weekend'})${value.digest ? ', plus the morning brief' : ''}.`

  function toggle(field: keyof ProactiveSettings) {
    onChange({ ...value, [field]: !value[field] })
  }

  function setFrequency(freq: ProactiveSettings['checkInFrequency']) {
    onChange({ ...value, checkInFrequency: freq })
  }

  function toggleCategory(cat: string) {
    const has = value.reminderCategories.includes(cat)
    const next = has
      ? value.reminderCategories.filter((c) => c !== cat)
      : [...value.reminderCategories, cat]
    onChange({ ...value, reminderCategories: next })
  }

  return (
    <div className="onb-controls">
      <div className="onb-controls__row onb-controls__row--switch">
        <div>
          <strong>Proactive messages</strong>
          <p>Alpha can text you on its own — check-ins, reminders, digests.</p>
        </div>
        <label className="onb-switch">
          <input
            type="checkbox"
            checked={value.enabled && !value.everythingOff}
            onChange={() => {
              if (value.everythingOff) onChange({ ...value, everythingOff: false, enabled: true })
              else toggle('enabled')
            }}
          />
          <span aria-hidden />
        </label>
      </div>

      {(value.enabled || !value.everythingOff) && !value.everythingOff && (
        <>
          {full && (
            <div className="onb-controls__row">
              <div>
                <strong>Reminder categories</strong>
                <p>Only these kinds of proactive reminders. Pick the ones that help.</p>
              </div>
            </div>
          )}
          {full && (
            <div className="onb-chips onb-chips--sm">
              {REMINDER_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`onb-chip ${value.reminderCategories.includes(cat) ? 'onb-chip--on' : ''}`}
                  onClick={() => toggleCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          <div className="onb-controls__row">
            <div>
              <strong>Check-in frequency</strong>
              <p>How often Alpha checks in when nothing is scheduled.</p>
            </div>
            <div className="onb-seg">
              {(['off', 'weekly', 'daily'] as const).map((freq) => (
                <button
                  key={freq}
                  type="button"
                  className={value.checkInFrequency === freq ? 'onb-seg__on' : ''}
                  onClick={() => setFrequency(freq)}
                >
                  {freq === 'off' ? 'Off' : freq === 'weekly' ? 'Weekly' : 'Daily'}
                </button>
              ))}
            </div>
          </div>

          <div className="onb-controls__row onb-controls__row--switch">
            <div>
              <strong>Daily digest</strong>
              <p>One morning brief of the things that matter.</p>
            </div>
            <label className="onb-switch">
              <input type="checkbox" checked={value.digest} onChange={() => toggle('digest')} />
              <span aria-hidden />
            </label>
          </div>

          <div className="onb-controls__row">
            <div>
              <strong>Preview next scheduled message</strong>
              <p className="onb-preview">{previewLine}</p>
            </div>
            <button type="button" className="plat-btn plat-btn--sm plat-btn--ghost" onClick={() => setPreviewOpen((v) => !v)}>
              {previewOpen ? 'Hide' : 'Preview'}
            </button>
          </div>

          <div className="onb-controls__row">
            <button type="button" className="plat-btn plat-btn--sm" onClick={() => onChange({ ...value, pausedToday: true })}>
              Pause for today
            </button>
            <button type="button" className="plat-btn plat-btn--sm plat-btn--ghost" onClick={() => onChange({ ...value, everythingOff: true, enabled: false })}>
              Turn everything off
            </button>
          </div>

          {value.pausedToday && (
            <p className="onb-note">Paused for today. It resumes tomorrow automatically.</p>
          )}
        </>
      )}

      {value.everythingOff && (
        <div className="onb-controls__row">
          <p className="onb-note">
            Everything is off. Alpha will not send anything until you turn it back on.
          </p>
          <button type="button" className="plat-btn plat-btn--sm" onClick={() => onChange({ ...value, everythingOff: false, enabled: true })}>
            Turn back on
          </button>
        </div>
      )}
    </div>
  )
}
