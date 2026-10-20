# DESIGN.md

How Self-Host MC looks and feels. Read this before adding or changing any screen. The source of truth for values is `src/renderer/cyberpunk.css` (Neon, the default) and `src/renderer/styles.css` (Classic); if they disagree with this file, the CSS wins and this file gets updated.

## Principles
- **Readable first, neon second.** Body text stays plain, high-contrast Barlow. Glow, cut corners and glitch live on edges, headings and accents only.
- **One main action per screen.** Each screen leads with a status card and one primary (filled) button. Everything else is outline or ghost.
- **No console needed.** Every common action is a button or right-click menu item. Errors say what to do next, in plain language.
- **Every new screen works in both themes.** Use the tokens below, never raw hex in components.

## Colour tokens (Neon)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#07080d` | window background (under a faint 40px cyan grid and two soft radial glows) |
| `--panel` / `--panel-2` / `--panel-3` | `#0e1018` / `#151826` / `#1d2133` | cards, hover, selected |
| `--border` | `#262c44` | all 1px borders |
| `--text` / `--muted` | `#eef1f8` / `#9ba3bd` | body / secondary text |
| `--accent` | `#fcee0a` neon yellow (user can pick cyan, magenta, green) | primary buttons, active tab, running state, the join address |
| `--edge` | `#00e5ff` cyan (swaps with accent choice) | hover outlines, card edge strip, labels, input underline |
| `--danger` | `#ff3b6b` | stop/delete, crashed |
| `--warn` | `#ffb020` | notices |
| `--on-accent` | `#0a0a0a` | text on filled accent |

`*-soft` tokens (12-14% alpha of the colour) are for glows and tinted backgrounds only.

## Type
- **Rajdhani** 600-700, UPPERCASE, letter-spacing 0.04-0.06em: headings, tabs, buttons, status line, sidebar labels.
- **Barlow** 400-600, 14.5px: body text and form labels. Never uppercase.
- **Share Tech Mono**: addresses, console, tags, badges, version numbers, anything a user might copy.
- Sizes: h1 30, h2 20, h3 16 (accent colour), status line 26, big address 22.

## Shape
- Radius is effectively 0 (`--radius: 2px`). No rounded corners in Neon.
- Cards, modals and pack cards: top-right and bottom-left corners cut by `--cut` (12px) via `clip-path`, plus a 42px glowing `--edge` strip on the top-left.
- Buttons: 8px cut corners. Sidebar items: 10px cut top-right.
- Status dots are diamonds (squares rotated 45deg).

## Components
- **Status card**: 3px left border. Running = accent border + inner accent glow + slow light sweep. Problem = danger border + inner danger glow.
- **Buttons**: `.btn` outline (hover turns cyan), `.btn-primary` filled accent with glow on hover, `.btn-danger` red outline, `.btn-ghost` borderless muted. `.btn-lg` for the one main action.
- **Inputs**: near-black fill, 1px border, cyan bottom border; focus = 1px accent outline + soft glow.
- **Tabs**: uppercase muted; active = accent text + 2px accent underline.
- **Progress**: 6px flat bar, cyan-to-accent gradient. Always paired with a named step ("Installing Java"), never a raw log.
- **Notices**: flat, 3px warn (or danger) left border.
- **Right-click menus and toasts**: flat, cyan border, hover = accent-soft fill.
- **Join address**: big mono text in accent, inside an accent-bordered box with inner glow. It is the most important thing on a running server's screen.

## Motion
- Allowed: glitch on the brand name hover and empty-state h1, flicker on online dots, sweep on a running status card.
- All motion stops when the app's motion setting is off or Windows asks for reduced motion. New animations must respect `html[data-motion="off"]` and `prefers-reduced-motion`.
- Faint scanlines overlay the whole window and must never block clicks (`pointer-events: none`).

## Classic theme
Rounded, calm dark-grey look in `styles.css`. Same layout and component names; only tokens and shapes change. New components must look fine in Classic without Neon-only effects.

## Do not
- Copy another product's look or logo.
- Put glow or uppercase on paragraph text.
- Add a second filled primary button to a screen.
- Hard-code colours; add a token instead.
