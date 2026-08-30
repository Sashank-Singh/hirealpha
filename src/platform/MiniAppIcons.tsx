import type { ReactNode } from 'react'

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * Calm, minimal line icons.
 *
 * Design rules:
 * - 1.7px stroke
 * - currentColor only
 * - no unnecessary fills
 * - one visual idea per icon
 * - consistent 24x24 coordinate system
 */
const ICONS: Record<string, ReactNode> = {
  nutrition: (
    <g {...STROKE}>
      <path d="M4.6 10h14.8" />
      <path d="M6.2 10c.5 6.6 2.6 9.8 5.8 9.8s5.3-3.2 5.8-9.8" />
      <path d="M9.2 6.4c.8-.8 5.8-.8 6.6 0" />
    </g>
  ),

  habit_streak: (
    <g {...STROKE}>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.6 12.2l2.3 2.3 4.6-5" />
    </g>
  ),

  mood_tracker: (
    <>
      <g {...STROKE}>
        <circle cx="12" cy="12" r="8" />
        <path d="M9 14.4c.9 1.4 5.1 1.4 6 0" />
      </g>

      <circle
        cx="9.3"
        cy="10.2"
        r="1"
        fill="currentColor"
      />

      <circle
        cx="14.7"
        cy="10.2"
        r="1"
        fill="currentColor"
      />
    </>
  ),

  workout_log: (
    <g {...STROKE}>
      <path d="M4.2 9.4v5.2" />
      <path d="M7 7.8v8.4" />
      <path d="M17 7.8v8.4" />
      <path d="M19.8 9.4v5.2" />
      <path d="M7 12h10" />
    </g>
  ),

  sleep_tracker: (
    <g {...STROKE}>
      <path d="M14.2 5.6A7.6 7.6 0 1 0 18.4 16.8 6.4 6.4 0 0 1 14.2 5.6z" />
    </g>
  ),

  spending_snapshot: (
    <g {...STROKE}>
      <rect
        x="3.8"
        y="7.2"
        width="16.4"
        height="9.6"
        rx="1.6"
      />
      <circle cx="12" cy="12" r="2.1" />
    </g>
  ),

  home: (
    <g {...STROKE}>
      <path d="M4 10.4 12 4.3l8 6.1" />
      <path d="M6 9.6v9.8h12V9.6" />
      <path d="M10.1 19.4v-5.2h3.8v5.2" />
    </g>
  ),

  networking_crm: (
    <g {...STROKE}>
      <circle cx="9" cy="8.6" r="2.3" />

      <path d="M4.8 16.8c.3-2.6 1.8-4 4.2-4s3.9 1.4 4.2 4" />

      <circle cx="15.6" cy="9" r="2.1" />

      <path d="M13.2 16.8c.3-2.1 1.4-3.3 3.2-3.3 2 0 3.3 1.3 3.6 3.3" />
    </g>
  ),

  body: (
    <g {...STROKE}>
      <circle cx="12" cy="6.2" r="2.1" />
      <path d="M8.2 20.2V11.4h7.6v8.8" />
      <path d="M8.2 13.6H5.6v4.4" />
      <path d="M15.8 13.6h2.6v4.4" />
    </g>
  ),

  later: (
    <g {...STROKE}>
      <path d="M5.4 7.2h13.2v11.2H5.4z" />
      <path d="M5.4 7.2l6.6 5.2 6.6-5.2" />
    </g>
  ),

  open_loops: (
    <g {...STROKE}>
      <path d="M9.4 10.6l5-5a2.6 2.6 0 0 1 3.7 3.7l-8.4 8.4a3.5 3.5 0 0 1-5-5l7.6-7.6" />
    </g>
  ),

  digest: (
    <>
      <g {...STROKE}>
        <rect
          x="4.6"
          y="6.2"
          width="14.8"
          height="13.2"
          rx="2"
        />

        <path d="M4.6 10.2h14.8" />
        <path d="M8.2 4.6v3" />
        <path d="M15.8 4.6v3" />
      </g>

      <circle
        cx="9.2"
        cy="14.4"
        r="1.05"
        fill="currentColor"
      />
    </>
  ),

  learning_queue: (
    <g {...STROKE}>
      <path d="M7.2 4.8h9.6v14.6l-4.8-3-4.8 3z" />
    </g>
  ),

  pick_night: (
    <g {...STROKE}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.6v4.6l3.2 1.8" />
    </g>
  ),

  tonight: (
    <>
      <g {...STROKE}>
        <path d="M19.65 12.67A7.65 7.65 0 1 1 11.33 4.35 5.95 5.95 0 0 0 19.65 12.67z" />
      </g>

      <circle
        cx="18.4"
        cy="6.4"
        r="1"
        fill="currentColor"
      />
    </>
  ),

  weekly_review: (
    <g {...STROKE}>
      <rect
        x="4.6"
        y="6.2"
        width="14.8"
        height="13.2"
        rx="2"
      />

      <path d="M4.6 10.2h14.8" />
      <path d="M8.2 4.6v3" />
      <path d="M15.8 4.6v3" />
      <path d="M8.4 14.6l2 2 4.4-4.4" />
    </g>
  ),

  drop_zone: (
    <g {...STROKE}>
      <path d="M5 14.2v3.6c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6v-3.6" />
      <path d="M12 4.8v10" />
      <path d="M8.4 11.2L12 14.8l3.6-3.6" />
    </g>
  ),

  meeting_mode: (
    <g {...STROKE}>
      <rect
        x="3.8"
        y="7"
        width="12.2"
        height="10"
        rx="1.8"
      />

      <path d="M16 10.2l4.2-2.2v8l-4.2-2.2z" />
    </g>
  ),

  approve_send: (
    <g {...STROKE}>
      <path d="M4.4 12l15.2-7.2-3.8 16.2-4.6-6.2z" />
      <path d="M11.2 14.8l3.8 4.2" />
    </g>
  ),

  pick_slot: (
    <g {...STROKE}>
      <rect
        x="4.6"
        y="6.2"
        width="14.8"
        height="13.2"
        rx="2"
      />

      <path d="M4.6 10.2h14.8" />
      <path d="M8.2 4.6v3" />
      <path d="M15.8 4.6v3" />
      <path d="M9 14.6h6" />
    </g>
  ),

  standup_paste: (
    <g {...STROKE}>
      <rect
        x="6.2"
        y="5.6"
        width="11.6"
        height="13.8"
        rx="1.6"
      />

      <rect
        x="9"
        y="4.4"
        width="6"
        height="2.6"
        rx="0.8"
      />

      <path d="M9 11h6" />
      <path d="M9 14.2h4.4" />
    </g>
  ),

  linear_triage: (
    <g {...STROKE}>
      <path d="M5 8h14" />
      <path d="M5 12h10" />
      <path d="M5 16h6" />
    </g>
  ),

  decision_ledger: (
    <g {...STROKE}>
      <path d="M7.2 4.8h7.2l4.4 4.4v10c0 .9-.7 1.6-1.6 1.6H7.2c-.9 0-1.6-.7-1.6-1.6V6.4c0-.9.7-1.6 1.6-1.6z" />

      <path d="M14.2 4.8v4.2h4.4" />

      <path d="M8.6 13h6.8" />
      <path d="M8.6 16h4.4" />
    </g>
  ),

  pipeline_board: (
    <g {...STROKE}>
      <rect
        x="4.2"
        y="5.4"
        width="4.4"
        height="13.2"
        rx="1"
      />

      <rect
        x="9.8"
        y="5.4"
        width="4.4"
        height="8.8"
        rx="1"
      />

      <rect
        x="15.4"
        y="5.4"
        width="4.4"
        height="11.2"
        rx="1"
      />
    </g>
  ),

  relationship_radar: (
    <>
      <g {...STROKE}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4.2" />
      </g>

      <circle
        cx="16.4"
        cy="8.4"
        r="1.2"
        fill="currentColor"
      />
    </>
  ),

  kill_keep_park: (
    <g {...STROKE}>
      <circle cx="6.2" cy="12" r="2.1" />
      <circle cx="12" cy="12" r="2.1" />
      <circle cx="17.8" cy="12" r="2.1" />
    </g>
  ),

  hire_decision: (
    <g {...STROKE}>
      <circle cx="10" cy="8.4" r="2.4" />

      <path d="M5.4 17.2c.4-2.8 2-4.3 4.6-4.3 2.6 0 4.2 1.5 4.6 4.3" />

      <path d="M15.2 12.4l1.8 1.8 3.4-3.6" />
    </g>
  ),

  approve_investor_note: (
    <g {...STROKE}>
      <path d="M7.2 4.8h7.2l4.4 4.4v10c0 .9-.7 1.6-1.6 1.6H7.2c-.9 0-1.6-.7-1.6-1.6V6.4c0-.9.7-1.6 1.6-1.6z" />

      <path d="M14.2 4.8v4.2h4.4" />

      <path d="M8.8 14.6l2 2 4.2-4.4" />
    </g>
  ),

  gratitude_journal: (
    <g {...STROKE}>
      <path d="M12 18.4s-6.4-3.8-6.4-8.2A3.2 3.2 0 0 1 12 8.4a3.2 3.2 0 0 1 6.4 1.8c0 4.4-6.4 8.2-6.4 8.2z" />
    </g>
  ),

  next_move: (
    <g {...STROKE}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </g>
  ),
}

const FALLBACK = (
  <g {...STROKE}>
    <rect
      x="5"
      y="5"
      width="14"
      height="14"
      rx="3"
    />
  </g>
)

export function MiniAppIcon({
  kind,
}: {
  kind: string
}) {
  return (
    <Mark>
      {ICONS[kind] ?? FALLBACK}
    </Mark>
  )
}