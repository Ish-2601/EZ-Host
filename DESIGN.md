# DESIGN.md

How EZ Host looks and feels. Read this before adding or changing any screen. There are three themes:

- **HUD** (default): `src/renderer/hud.css`
- **Neon**: `src/renderer/cyberpunk.css`
- **Classic**: `src/renderer/styles.css`, which is also the base layout every theme builds on

If a CSS file disagrees with this document, the CSS wins and this file gets updated.

## Principles
- **Readable first, style second.** Body text stays plain, high-contrast Barlow. Brackets, glow, uppercase and mono labels go on edges, headings and accents only.
- **One main action per screen.** Each screen leads with a status card and one primary (filled) button. Everything else is outline or ghost.
- **No console needed.** Every common action is a button or a right-click menu item. Errors say what to do next, in plain language.
- **Every new screen works in all three themes and both games.** Use the tokens below, never raw hex in components. Minecraft-only UI must be hidden in the Zomboid section (`html[data-game="zomboid"]`), and Zomboid-only UI uses `.zb-only`.

## Customization (App settings → Look)
Each choice is a data attribute on `<html>`. `theme-boot.js` sets them before the first paint, so the wrong theme never flashes.

| Setting | Attribute | Values |
|---|---|---|
| Theme | `data-theme` | `hud`, `cyberpunk`, `classic` |
| Accent colour | `data-accent` | HUD: `orange` (default), `red`, `white`, `yellow`, `cyan`, `magenta`, `green`. Neon: `yellow`, `cyan`, `magenta`, `green` |
| Panels (HUD) | `data-panels` | `brackets` (default), `outline`, `solid` |
| Background (HUD) | `data-bg` | `globe` (wireframe globe and dot grid), `grid`, `plain` |
| Spacing | `data-density` | `compact`, `comfortable`, `spacious` |
| Status strip | `data-strip` | `on` / `off`: a top bar with one square per server, totals and a clock |
| Animations | `data-motion` | `on` / `off` |

New look options get a value in `manager.appSettings()`, a control in the App settings form, and an attribute in both `applyAppearance()` and `theme-boot.js`.

## HUD theme
Inspired by sci-fi data dashboards: near-black, thin white and grey linework, small mono labels, a few orange accents.

### Tokens
| Token | Value | Use |
|---|---|---|
| `--bg` | `#050607` | window background, under the globe or grid art (`hud-globe.svg` plus a 22px dot grid at low opacity) |
| `--panel` / `--panel-2` / `--panel-3` | `rgba(12,13,16,.88)` / `#15171b` / `#1d2025` | cards, hover, selected |
| `--border` | `#2b2f36` | all 1px borders |
| `--line` | `#c9ced6` | corner brackets and linework |
| `--text` / `--muted` | `#e9ebee` / `#868d97` | body / secondary text |
| `--accent` | `#ff7a1a` orange (user can change it) | primary buttons, active tab underline, running state, label ticks, the join address |
| `--danger` | `#ff3d3d` | stop/delete, crashed |
| `--warn` | `#ffb020` | notices, starting |

### Type
- **Share Tech Mono**, uppercase, letter-spacing 0.1 to 0.18em, 10.5 to 12.5px: card titles (h3, with a 6px accent square in front), tabs, buttons, sidebar labels (prefixed `//`), tags and the status strip.
- **Rajdhani** 700 uppercase: h1, h2, the status line, the EZH wordmark.
- **Barlow** 14px: body text and form labels. Never uppercase.

### Shape
- Square corners everywhere (`--radius: 0`).
- Panels: a 1px border plus four 12px corner brackets in `--line`, drawn on `::after` so they never take clicks. The brackets turn accent-coloured on hover and selection for pick cards. With `data-panels="outline"` the brackets go away; with `solid` the panels are filled with `--panel-2` and have no border.
- Status dots and strip cells are small squares.

### Motion
Only the running status squares blink, slowly. Nothing else moves. It all stops with `data-motion="off"` or Windows reduced motion.

## Neon theme (cyberpunk)
Neon on near-black with cut corners and light scanlines. The tokens are in `cyberpunk.css`: yellow accent by default, a cyan `--edge`, Rajdhani headings, and a 12px `--cut` on cards via `clip-path`. Allowed motion is a glitch on the brand name hover, flicker on online dots and a sweep on a running status card.

## Classic theme
A rounded, calm dark-grey look in `styles.css`. It uses the same layout and component names; only tokens and shapes change. New components must look fine in Classic without the effects of the other themes.

## Logo
`src/renderer/icon.svg` is a wireframe globe inside HUD corner brackets, with an orange link arc between two hot spots ("friends anywhere, connected to your PC"). It is original artwork. `npm run make-icon` renders it to `build/icon.png` for the installer and window. It must not use any game's art.

## Components (all themes)
- **Status card**: running = accent left border; problem = danger left border with a tinted background.
- **Buttons**: `.btn` outline, `.btn-primary` filled accent, `.btn-danger` red outline, `.btn-ghost` borderless and muted, `.btn-lg` for the one main action.
- **Progress**: a thin flat bar, always paired with a named step ("Installing Java"), never a raw log.
- **Join address**: big mono text in the accent colour inside an accent-bordered box. It is the most important thing on a running server's screen.
- **Right-click menus, toasts and dropdowns** (`.ctx-menu`, `.toast`, `.suggest-list`): flat, with a 1px light border. Hover uses the accent-soft fill. Dropdowns are `position: fixed` so card clipping never cuts them off.

## Do not
- Copy another product's look or logo, or use a game's art in the app's branding.
- Put glow or uppercase on paragraph text.
- Add a second filled primary button to a screen.
- Hard-code colours; add a token instead.
