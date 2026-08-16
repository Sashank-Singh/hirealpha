# HireAlpha Onboarding Design

## Product Goal

Make Alpha useful and personal in the first conversation without making the user guess what Alpha knows, what it can access, or how to change those choices later.

The first high-value moment is simple:

> "Find the best coffee shops nearby"

Alpha should know which location to search, use real map data, and return one coherent answer.

## Decisions

- Exact GPS is required during initial setup.
- Home and work locations are supported.
- Alpha is both a personal companion and a broader personal operating system.
- Setup is split into two stages rather than one giant form.
- Connectors are offered upfront through an explicit "Connect all" action.
- Alpha is controlled-proactive by default, with visible schedules, quiet hours, categories, pause, and kill controls.

## Flow

### Stage 0: Explain The Contract

Show this before requesting permissions:

**Alpha works better when it knows your context.**

We will use your location for nearby recommendations, weather, directions, and plans. You choose what Alpha can access. You can update or remove it from Settings at any time.

Actions:

- `Set up Alpha`
- `See what will be collected`
- `Skip for now` only for users who cannot complete setup; nearby features remain blocked until location is supplied.

Do not request browser permissions before this explanation.

### Stage 1: Required Setup

Keep this to roughly 60 to 90 seconds. Save after every completed step so a refresh, permission denial, or failed connector does not erase progress.

#### 1. Identity

Collect:

- Preferred name
- Optional pronouns
- Optional short answer: "What should Alpha help with most?"

Use the name immediately in the confirmation screen. Do not force pronouns or a long biography.

#### 2. Exact Current Location

Ask for browser location permission with a clear purpose:

> "Allow location so Alpha can find places near you, give local weather, and plan around where you are."

Actions:

- `Allow current location`
- `Enter an address manually`
- `Use city or neighborhood instead`

Required behavior:

- Use `navigator.geolocation` only after the user taps the allow action.
- Show the detected place label before saving it, for example `SoMa, San Francisco`.
- Let the user correct the label if the result is wrong.
- Store accuracy and timestamp.
- Never put raw coordinates into the LLM prompt or conversational memory.
- Use the coordinates on the backend for map and weather queries.

If permission is denied, explain the consequence and offer manual entry. Do not loop the permission prompt.

#### 3. Home And Work Locations

Because the selected product direction includes home and work, ask separately after current location:

- `Save this as Home`
- `Save this as Work`
- `Use a different location`
- `Skip Home/Work`

Never infer that the current location is home or work without an explicit user action.

Each location needs:

- Label: Home or Work
- Coordinates or normalized address
- User-confirmed display label
- Accuracy
- Last updated time

Alpha should say which location it used when relevant: "I searched near your current location" or "I used Work."

#### 4. Time And Communication

Detect timezone from the browser and let the user confirm or change it. Ask for:

- Timezone
- Quiet hours
- Preferred response style: concise, balanced, or conversational
- Whether Alpha may ask follow-up questions when information is missing

Default quiet hours should be conservative and visible. Never send a proactive message outside them.

#### 5. What Alpha Should Know First

Use selectable chips, not an open-ended form:

- Food and restaurants
- Plans and dates
- Travel and directions
- Reminders and routines
- Emotional support
- Email and calendar
- Fitness and nutrition

Ask the user to choose up to three priorities. This controls the first feature card and gives Alpha a clear starting point without pretending the other capabilities do not exist.

#### 6. First Proof Of Value

Immediately show one action based on the selected priorities:

- Food: find a nearby coffee shop or restaurant
- Plans: suggest a local plan using the saved location
- Reminders: create a test reminder
- Email/calendar: show what the connector enables
- Nutrition: open the nutrition card

The first action must return one answer, not a menu of explanations. This is where the user decides whether Alpha feels useful.

#### 7. Connectors

Show a connector review screen with a primary `Connect all` action, but keep permissions legible per service.

Each connector card must state:

- What Alpha can read or do
- Why it helps
- Whether access is read-only or write-capable
- What the user can revoke later
- Current state: Not connected, Connected, Expired, or Error

The user selected upfront connection as the default direction, but a failed or declined connector must not block the rest of onboarding. Never claim a connector is available until its connection is confirmed.

### Stage 2: Complete The Profile

Offer this after the first successful proof, with a progress indicator and a `Finish later` action.

Collect progressively:

- Favorite cuisines, dietary restrictions, allergies, budget, and dining preferences
- Favorite neighborhoods and places to avoid
- Home/work hours and commute preferences
- Important people and relationships the user chooses to share
- Recurring routines and reminder preferences
- Check-in categories and frequency
- Calendar, Gmail, maps, and other connector preferences
- Notification channels and quiet hours
- Data retention and location controls

Every field should explain its user benefit. Do not ask for sensitive details that do not unlock a specific feature.

## Location Model

Location is a capability, not a chat fact.

Recommended server-side fields:

- `current_latitude`
- `current_longitude`
- `current_accuracy_m`
- `current_label`
- `current_updated_at`
- `home_latitude`
- `home_longitude`
- `home_label`
- `home_updated_at`
- `work_latitude`
- `work_longitude`
- `work_label`
- `work_updated_at`
- `location_permission_status`
- `location_source`

Keep these in a dedicated location record or protected context fields. Do not extract them as durable LLM memories.

Location rules:

- Current location expires quickly and can be refreshed.
- Home and work require explicit labels and explicit delete actions.
- The map backend chooses the active location: current, home, work, or a named place.
- The LLM receives only the resulting place data and a safe label such as `near Work in San Francisco`.
- If exact location is unavailable, ask for a city, neighborhood, or address instead of guessing.
- If the user travels, Alpha should ask whether to refresh current location rather than silently changing Home or Work.

## Proactive Behavior

The setup must include a control panel before Alpha sends anything proactive.

Controls:

- Enable or pause all proactive messages
- Quiet hours and timezone
- Check-in frequency
- Reminder categories
- Daily digest on or off
- Preview next scheduled message
- `Pause for today`
- `Turn everything off`

The user should be able to type `stop proactive messages` and receive confirmation immediately.

## Failure And Recovery States

Every step needs a non-dead-end state:

- Location permission denied: manual address or city entry
- Location unavailable: retry once, then manual entry
- Inaccurate location: show the detected label and allow correction
- User moved: refresh current location without changing Home or Work
- Connector declined: continue with the rest of setup
- Connector expired: show reconnect action and do not claim access
- Network failure: preserve completed steps and offer retry
- Browser does not support geolocation: manual entry
- User closes onboarding: resume at the last incomplete step
- User changes mind later: edit, revoke, delete, and reset from Settings

## Copy Rules

- Say exactly why data is requested.
- Never say "Alpha knows where you are" without naming the location source and timestamp.
- Never imply continuous tracking unless continuous tracking actually exists and the user explicitly enabled it.
- Never use "nearby" when the search is only city-wide.
- If data is missing, ask one direct question instead of producing a confident guess.
- Keep the bot voice warm and direct. No taglines or authenticity catchphrases.

## Acceptance Criteria

- A new user can complete required setup in under 90 seconds.
- A user can finish setup without granting browser GPS by entering a location manually.
- Current, Home, and Work are visibly distinct and never silently substituted.
- Nearby searches use backend coordinates and return one coherent reply.
- Raw coordinates never appear in LLM prompts, message history, or durable memory.
- Permission denial, stale location, connector failure, and network failure are recoverable.
- Every onboarding step is resumable and idempotent.
- Users can update or delete each location independently.
- Proactive messages cannot fire outside configured quiet hours.
- Connector state is truthful in both the dashboard and bot replies.
- End-to-end tests cover first setup, refresh, travel, denial, manual location, connector failure, and reset.

## Build Order

1. Add the location model and authenticated location endpoints.
2. Build the Stage 1 location and privacy flow.
3. Pass server-selected location into map and weather lookups without exposing coordinates to the model.
4. Add Home/Work management and stale-location behavior.
5. Add the connector review screen and truthful connection states.
6. Add Stage 2 profile fields and proactive controls.
7. Test the complete onboarding and nearby-search loop on desktop and mobile.
