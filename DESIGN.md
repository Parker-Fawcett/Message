# DESIGN.md — Private Chat

> **v2 ACTIVE — "Snap energy" pivot.** User named Snap as the target feel.
> Light-native, high-energy consumer messenger: signature `#FFFC00` yellow
> color-blocking, bold near-black type on white, playful rounded geometry,
> springy micro-motion. v1 (Linear dark-luxe) preserved below for reference;
> all v1 dark tokens are retired.

Design contract for the messenger UI. Provenance: public Snapchat brand
language (no official reference file exists in the library — documented
fallback per routing rules). Execution discipline: redesign-skill +
interaction-skill mechanics (springs, reduced motion, GPU-safe transforms).

## 1. Brand & Atmosphere

Bright, fast, confident. Yellow is the brand voice and appears as solid
color BLOCKS (active chips, own bubbles, send button) with near-black text
on top — never as thin accents. Everything is rounded and slightly
oversized-feeling. Whitespace comes from the white canvas; structure comes
from a single gray hairline family.

## 2. Color Tokens (ACTIVE)

| Token | Value | Use |
|---|---|---|
| `--bg-canvas` | `#ffffff` | App background |
| `--bg-panel` | `#ffffff` | Header, nav, composer (hairline-separated) |
| `--bg-surface` | `#f4f5f7` | Incoming bubbles, hover fills |
| `--snap-yellow` | `#FFFC00` | Own bubbles, active chip, send button, brand moments |
| `--ink` | `#16191c` | Primary text (on white AND on yellow) |
| `--text-secondary` | `#5b6168` | Secondary text |
| `--text-muted` | `#6b7075` | Timestamps, placeholders |
| `--accent-red` | `#f23c57` | Unread/notification badge (Snap red) |
| `--status-online` | `#2dbd4a` | Connection dot |
| `--error` | `#e5484d` | Errors |
| `--border-hairline` | `#e8eaed` | Default separators |
| Read receipt | `#0fadff` (Snap opened-blue) | `.text-blue-400` hook restyled visually via arbitrary value BUT class name preserved |

Own bubble = yellow block + ink text. Incoming = `#f4f5f7` block + ink text.
Yellow NEVER carries white text.

## 3. Typography

Geist Sans. Weights: 500 body/UI (chunkier than v1 — Snap is bold),
600/700 for titles and active chips. Timestamps 10px Geist Mono muted.

## 4. Spacing & Radius

Same grid. Radii pushed rounder: bubbles `rounded-[22px]` w/ one squared
corner, composer shell `rounded-full` pill, chips `rounded-full`,
modals/cards `rounded-3xl`.

## 5. Primitives & States

- Chip: white pill, `#e8eaed` border, ink text; active = yellow fill + ink
  semibold + subtle scale(1.02); unread badge = `#f23c57` red circle, white text.
- Bubble entrance: `bubble-in` spring-ish 260ms cubic-bezier(0.34,1.56,0.64,1)
  (slight overshoot — playful).
- Composer: white pill shell w/ hairline + soft shadow (`0 2px 12px rgba(22,25,28,0.08)`);
  send = yellow circle w/ ink arrow, press scale(0.92).
- Header buttons: ghost pills, hover `#f4f5f7`.
- Lock screen: white canvas, giant yellow radial glow top-center (40%
  opacity), white double-bezel card, yellow Unlock button w/ ink text.
- Focus rings: 3px `#FFFC00` + outer ink ring (yellow needs the dark halo
  on white).

## 6. Motion

`cubic-bezier(0.34, 1.56, 0.64, 1)` overshoot curve for entrances/presses;
200ms ease-out for color. Reduced-motion kills all (unchanged).

## 7. Responsive & Accessibility

Unchanged from v1 (safe-area, ≥44px targets, landmarks, contrast: ink on
yellow = 14.6:1 ✓).

## 8. Accepted Debt

v1 items plus: yellow-only light theme (no dark variant — Snap is
light-native); `.text-blue-400` literal class retained as suite hook while
rendering `#0fadff`.

---
---

# v1 (RETIRED) — Linear dark-luxe

Design contract for the messenger UI. Direction: **"encrypted terminal-luxe"** —
Linear's dark-native luminance system applied to a private chat; conversations
emerge from near-black like starlight, one chromatic voice (indigo-violet),
the lock screen as signature moment. References: `linear.app.md` (tokens),
`soft-skill.md` + `redesign-skill.md` + `interaction-skill.md` (execution).

## 1. Brand & Atmosphere

Dark-native product. Darkness IS the whitespace. Precision-engineered feel:
luminance hierarchy instead of color variety, whisper-thin white borders as
wireframes in moonlight. The single indigo accent marks only what talks
(active conversation, send action, focus). Security chrome (lock states) uses
muted lavender `#7a7fad`.

## 2. Color Tokens

| Token | Value | Use |
|---|---|---|
| `--bg-canvas` | `#08090a` | App background |
| `--bg-panel` | `#0f1011` | Header, nav bar, composer shell |
| `--bg-surface` | `#191a1b` | Elevated: incoming bubbles, cards |
| `--bg-hover` | `#23252a` / white/4% | Hover states |
| `--text-primary` | `#f7f8f8` | Primary text (never pure white) |
| `--text-secondary` | `#d0d6e0` | Body text |
| `--text-muted` | `#8a8f98` | Timestamps, placeholders |
| `--text-faint` | `#62666d` | Disabled, subtle labels |
| `--accent` | `#5e6ad2` | Own bubbles, send button, active chip |
| `--accent-bright` | `#7170ff` | Focus rings, active text |
| `--accent-hover` | `#828fff` | Accent hover |
| `--security-lavender` | `#7a7fad` | Lock/vault UI |
| `--status-online` | `#27a644` | Connection dot |
| `--border-hairline` | `rgba(255,255,255,.06)` | Default borders |
| `--border-standard` | `rgba(255,255,255,.08)` | Cards, inputs |
| Bubble incoming | `rgba(255,255,255,.04)` + border hairline | Received messages |
| Error | `#e5484d` | Vault errors |

Own bubbles are the ONE place accent fills solid — sender distinction demands it.

## 3. Typography

Geist Sans (loaded via next/font) + Geist Mono for timestamps/user-ids.
Weights: 400 read · 500 UI emphasis (Geist's medium ≈ Linear's 510 role) ·
600 announce. No 700.

| Role | Spec |
|---|---|
| App title | 15px / 500 / tracking -0.01em / `#f7f8f8` |
| Chip label | 13px / 450→500 active |
| Message body | 15px / 400 / lh 1.45 |
| Timestamp | 11px Geist Mono / muted |
| Badges/labels | 11px / 500 / uppercase tracking 0.08em where labels |

## 4. Spacing & Radius

8px base grid. Radii scale: chips/pills full · bubbles `rounded-2xl` with
one squared corner · composer shell `rounded-[1.75rem]` outer /
`rounded-[1.35rem]` inner (double-bezel concentric) · inputs/cards `12px` ·
modals `16px`. Composer max-width 3rem-side gutters via max-w-3xl centered.
Full-height = `h-dvh` never `h-screen`.

## 5. Primitives & States

- **Chip (conversation)**: pill, transparent bg, `white/8` border,
  secondary text; hover bg-white/4; active = `#5e6ad2` solid, white text;
  unread = indigo count dot. Class hook `.conv-chip`.
- **Bubble own**: `#5e6ad2` bg, white text, entrance `bubble-in` 240ms
  fade+rise 4px; status icon inline (sent gray → delivered gray double →
  read `text-blue-400`, hook preserved).
- **Bubble incoming**: surface bg + hairline border; group senders get a
  20px initial-avatar + name label above first bubble of a run.
- **Composer**: double-bezel — outer shell `white/[0.03]` ring-hairline
  rounded-full-ish; inner textarea transparent; send = 44px circle `#5e6ad2`,
  hover `#7170ff`, active `scale-95`; disabled 40% opacity.
- **Lock screen**: canvas bg + radial indigo glow (`radial-gradient` at
  center-top, 8% opacity) + double-bezel card + mono input. Error shake 320ms
  (disabled under reduced motion).
- **Vault modal**: backdrop `black/60` blur-sm, card = panel bg + standard
  border, radius 16px.
- All interactive elements: `transition-colors duration-200`,
  press `active:scale-[0.98]`, visible focus ring `ring-2 ring-[#7170ff]/60`.

## 6. Motion

Curve: `cubic-bezier(0.32, 0.72, 0, 1)` for transforms; colors 200ms ease-out.
Keyframes: `bubble-in` (opacity 0→1, translateY 6px→0), `pulse-dot`
(connection online, 2s), typing dots staggered bounce (existing, recolored).
Reduced motion: all keyframes/transitions disabled globally via media query.
GPU-safe properties only (transform/opacity).

## 7. Responsive & Accessibility

Mobile (<768px): chips scroll horizontally, composer sticks to safe-area,
touch targets ≥44px on send button, name input stays inline. Contrast:
secondary text on canvas ≥ 7:1; muted ≥ 4.5:1. Semantic landmarks kept
(header/nav/main/footer). Focus-visible rings on every control.

## 8. Accepted Debt

- Single dark theme only (light mode deferred — darkness is native medium).
- No avatar images; initials-only for groups.
- Read-receipt icon keeps literal class `.text-blue-400` (suite hook).
- Emoji glyphs in header controls replaced by inline SVGs; message-body emoji
  content from users remains user content.
