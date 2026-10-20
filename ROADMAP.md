# Self-Host MC roadmap

The goal: anyone can host a modded Minecraft server on their own PC in a few clicks, and their friends can join from anywhere, without knowing what Java, a mod loader, or port forwarding is.

Phases run in order. Nothing in a later phase starts until the phase before it is done and tested.

## Done so far

- Electron app with a server engine that runs without the UI
- Modrinth modpack search, `.mrpack` import, and hosting from a CurseForge or Prism profile on this PC
- Automatic Java (Temurin) and loader install: Fabric, Quilt, Forge, NeoForge, vanilla
- Client-only mods left off the server, unless another mod needs them
- Start, stop, live console, basic settings
- "How to join" tab: LAN addresses, exact versions players need, profile check, CurseForge `.zip` / `.mrpack` export

## Phase 1: must-haves

These come before any other feature.

### 1. Friends on other internet connections can join

**Why:** Today only people on your Wi-Fi can join. This is the main reason the app exists.

**How:** playit.gg's free tunnel, built into the app. Nothing to install and no router settings.

1. The app downloads the official playit agent from playit.gg's GitHub releases, the same way it downloads Java.
2. First time only: the app shows a "Connect playit.gg" button. It opens playit.gg in your browser to link this PC (a free account, made or signed into on playit's own site). The app never sees your password.
3. The app creates a Minecraft Java tunnel pointing at the server's port and saves it.
4. When you press Start, the tunnel starts too. When you stop the server, it stops.
5. The "How to join" tab shows the public address at the top (for example `something.joinmc.link`) with a Copy button. LAN and local addresses move below it.
6. Clear status: "Online address ready", "Connecting…", or what went wrong and how to fix it.

**Done when:** a friend on a different internet connection joins a running server using only the address the app shows.

### 2. Open the app like any other program

**Why:** You shouldn't need a terminal or `npm start`.

**How:** electron-builder with an NSIS installer.

1. `npm run dist` builds `Self-Host MC Setup x.y.z.exe` into `dist/`.
2. The installer adds a desktop shortcut and a Start menu entry, and appears in Windows "Apps" for uninstalling.
3. A real app icon (window, taskbar, shortcut, installer).
4. Uninstalling removes the app but keeps your servers and worlds, which live in `%APPDATA%\self-host-mc`.
5. Later: GitHub Releases for downloads and automatic updates (Phase 3).

**Note:** the installer is not code-signed at first, so Windows SmartScreen will show "Windows protected your PC". Click "More info", then "Run anyway". Signing costs money, so it can come later.

**Done when:** you can double-click the installer, then open Self-Host MC from the desktop or Start menu.

### 3. Clean, easy-to-understand UI

**Why:** The app should explain itself to someone who has never run a server.

**How:**

1. **Plain language everywhere.** Technical terms get a short explanation, error messages say what to do next, and console output stays out of the way unless you open it.
2. **One clear main action per screen.** The server screen leads with a big status card: Start/Stop, players online, the address to share, and what to do next ("Accept the EULA", "Installing 40%", "Ready, share this address").
3. **New server wizard** in three steps: choose where the mods come from (your CurseForge profile, Modrinth, or a file), choose RAM with a recommended default, then confirm.
4. **Friendly install progress:** one progress bar with named steps (Downloading mods, Installing Java, Installing Forge) instead of a log.
5. **Console tab for power users,** with errors highlighted and a "copy log" button.
6. **Players panel:** who is online, plus Kick/Op buttons, read from the server output.
7. Empty states and first-run tips, keyboard focus states, and readable contrast.

**Done when:** someone who has never hosted a server can create one, start it and share the address without asking for help.

Phase 1 status: all three are built. The online address was verified on 2026-10-19 by pinging a running server through its playit.gg address.

## Phase 1.5: Ishaan's requests (in build order)

Status: all six are built (2026-10-19). Tested on a throwaway server: pregeneration, force-loading, the map and long remote-control replies. Live player edits need a real player online to test.

| Feature | Why it matters |
| --- | --- |
| Right-click a server in the sidebar to open, rename, change settings, open its folder, or delete it (deleting asks first) | Managing servers should work the way it does everywhere else in Windows. |
| Vanilla servers (plain Minecraft, no mods) as a New server option | Not every game night needs mods. |
| A separate online address for each server: one playit.gg tunnel per server, each server on its own port. "Get a new address" picks a fresh one; custom names need playit.gg Premium or your own domain, and the app explains this | Different groups or worlds can be shared without mixing them up. |
| Pregenerate world button (using the Chunky mod): pick a radius, watch progress | Generating new chunks is the main cause of lag on modded servers. Pregenerating while nobody plays removes it. |
| Players panel: head, hearts, hunger, inventory and ender chest for online and offline players, plus editing (heal, feed, give or remove items, game mode, op, kick) | Hosts want to see and help their players without typing commands. |
| Whitelist control on the Players tab, host added automatically. Minecraft 26.3 turns the whitelist on by default, which blocked the host, so new servers now start with it off | Hosts choose who can join without typing commands. |
| Detailed map style (biome colors and structure markers such as villages and temples), map auto-refresh (10 s by default, or manual), right-click player menu (OP, teleport, game mode, heal, feed, kick, ban, kill), crown on OPs, whitelist off by default with one-click on and a "Trying to join" list with Approve/Deny | Ishaan asked for a seed-map style view and for everyday moderation without typing commands. |
| World map of explored chunks with live player heads. Select chunks to keep them loaded even with nobody nearby (for farms), and remove that again | Lets the host see the world and keep iron farms and similar builds running. |

## Phase 1.6: performance and mods (2026-10-19)

Built: startup progress with stages and a stall warning; hung-start detection (Forge can hang after a failed start); client-only mods that crash the server are turned off automatically and the server retries; a Mods tab listing every mod with on/off switches and detected problems; tuned Java (G1 settings, shared class archive on Java 19+); memory, settings and performance-mod suggestions; tick-rate monitor for Forge, NeoForge and vanilla; custom server icon.

## Phase 2: reliability

| Feature | Why it matters |
| --- | --- |
| Crash detection with a plain-language reason (missing mod, wrong Java, out of memory) and a suggested fix | Modded servers often fail on the first start. Users need to know what to do, not read stack traces. |
| Auto-restart if the server crashes while running | Friends shouldn't have to wait for the host to notice. |
| World backups: automatic before updates and on a schedule, with one-click restore | Mods corrupt worlds. Backups are the safety net. |
| RAM guidance from pack size and PC memory | Too little RAM crashes servers. Too much starves Windows. |
| Keep the PC awake while a server is running | Windows sleep kills the server and disconnects everyone. |
| Close-to-tray, so closing the window keeps the server running | Hosts often close the window without meaning to stop the game. |

## Phase 3: everyday hosting

| Feature | Why it matters |
| --- | --- |
| Player management: whitelist, ops, bans, with player heads | The main things hosts do once a server is running. |
| Terrain colors on the world map (read from the world's region files) | A map you can recognize your base on is easier to use than a grid. |
| Server settings editor for the common options (game mode, PvP, view distance, seed, spawn protection) with explanations | Editing `server.properties` by hand is error-prone. |
| Modpack updates: "a new version is available" and a safe update that backs up first | Packs update often, and players need to match. |
| Add or remove single mods from Modrinth | Hosts want to tweak a pack without rebuilding it. |
| World import (from singleplayer saves) and export | People often want to continue a world they already started. |
| Automatic app updates via GitHub Releases | Users get fixes without reinstalling. |
| Join link for friends: a page with the address, required pack and import steps | One link to send instead of three instructions. |

## Phase 4: more sources and polish

| Feature | Why it matters |
| --- | --- |
| CurseForge modpack search inside the app (needs a CurseForge API key) | Many popular packs are only on CurseForge. |
| Use the pack's official server pack when it has one | It is the pack author's tested server setup. |
| Performance view: TPS, memory and CPU graph, lag warnings | It helps hosts find out why the game feels slow. |
| Scheduled restarts and in-game warnings | Long-running modded servers leak memory. |
| Code-signed installer | Removes the SmartScreen warning. |
| macOS and Linux builds | Friends who host on other systems. |

## Ideas, not scheduled

- Discord notifications when the server starts or someone joins
- Bedrock players joining Java servers (Geyser), for vanilla-style packs
- Sharing a server setup as a file another host can import
