# HireAlpha — A little more living

30 seconds · 1920 × 1080 · 30 fps · H.264/AAC · original instrumental score.

## Deliverables and editing

- `out/hirealpha-launch-30s.mp4`: native X upload.
- `out/hirealpha-launch-poster.png`: poster frame.
- `src/LaunchFilm.tsx`: editable Remotion composition.
- `scripts/score.py`: deterministic original score; no stock music or samples.

Remotion 4.0.515 was already installed and successfully rendered this film. The previous PhoneVideo composition and promo.mp4 are preserved.

```sh
cd video
npm install
npm run score
npm run typecheck
npm run dev
npm run render:launch
npm run still:launch
```

## Story

| Time | Beat |
| --- | --- |
| 0–4 | Your day has too many tabs. |
| 4–9.5 | An assistant who texts first. |
| 9.5–15 | Your morning brief: calendar, priorities, open loops. |
| 15–21 | Text a meal → nutrition estimate. |
| 21–26 | A little less managing. A little more living. |
| 26–30 | Meet Alpha → hirealpha.chat. |

The film uses the teal Alpha face, Messages interaction model, warm editorial landing-page palette and dark mini-app styling. Product moments are animated illustrations with sample data, labeled in the film; they are not live recordings or pixel-identical production screens. Local landing reference: public/reference/landing.png. Product context checked in README.md, marketing/launch-kit/00-facts.md, Landing.tsx, BriefApp.tsx and mini-app CSS. The film focuses on the live personal assistant, without workshop-persona or pricing claims.

## Launch research

Checked September 21, 2026. These are creative inputs, not a guarantee of virality or a definitive ranking of viral videos.

- [X creative best practices](https://business.x.com/en/advertising/creative-best-practices): movement early and concise messaging. Applied with early motion, persistent branding and readable sound-off storytelling.
- [X specifications](https://business.x.com/en/help/campaign-setup/creative-ad-specifications): recommended landscape dimensions include 1920 × 1080. Kept the requested 30-second length.
- [YC launch instructions](https://news.ycombinator.com/yli.html): make the product easy to try and demonstrate what it does. Applied through concrete examples and one clear destination. This is a social launch film, not a YC application founder video.
- [Linear Dashboards launch](https://linear.app/changelog/2025-07-24-dashboards): product-centered reference. Creative inference: give each scene one job and give the UI room to read. No engagement ranking is claimed.
- [a16z on Cluely](https://a16z.com/announcement/investing-in-cluely/): its investor attributes awareness to viral campaigns, audience-building experience and systematic user-generated content. Distribution extends beyond one polished film; equivalent results for HireAlpha cannot be inferred.

## Ready-to-post X copy

Your day has too many tabs.

Meet HireAlpha: a personal assistant in your Messages.

It texts first. Pulls your morning together. Turns a quick text into a nutrition log.

A little less managing. A little more living.

Meet Alpha → https://hirealpha.chat

Attach the MP4 natively. Publish from the founder account and be available for product questions. Follow up with a real product walkthrough and what you learn from users. Measure landing visits → signup → first useful completed task → paid conversion. Views alone do not establish customer acquisition.

No social post was published during production.

## Verification

TypeScript check passed. The exported video stream contains exactly 900 frames at
30 fps (30.000 seconds), 1920 × 1080, H.264 with AAC sound. Representative frames
from all six scenes were inspected for framing and layout; the nutrition headline
was widened after review. Audio was checked for clipping. AAC packet padding may
make the container report approximately 30.06 seconds even though the video is
exactly 30 seconds.

## Additional versions

- **Midnight** — `out/hirealpha-midnight-30s.mp4`. 1920 × 1080, 30 seconds. Dark mint palette, bold kinetic typography, notification-to-brief sequence and a driving synthesized score. Composition: HireAlphaMidnight.
- **Conversation** — `out/hirealpha-conversation-30s.mp4`. 1080 × 1080, 30 seconds. Warm square composition, oversized message bubbles, morning and nutrition examples, and a lighter original score. Composition: HireAlphaConversation.

Both use labeled illustrative product examples, with no live customer data. Edit
`src/MoreFilms.tsx`; regenerate sound with `npm run score:versions`; export with
`npm run render:midnight` and `npm run render:conversation` from the video folder.
