# Self-Host MC

A free desktop app for hosting a modded Minecraft server on your own PC so friends can join, even when you are not in game.

Pick a modpack from Modrinth (or import a `.mrpack` file), and the app downloads the server-side mods, installs the right Java version and mod loader, and runs the server as a real dedicated server with a live console.

## Status

Early development. Working today:

- Search Modrinth for server-ready modpacks and pick a version
- Import a `.mrpack` file from disk
- Server-side mod download with hash checks (client-only mods are skipped)
- Automatic Java install (Eclipse Temurin, picked from Mojang's version metadata)
- Automatic loader install: Fabric, Quilt, Forge, NeoForge, or vanilla
- Start, stop, and a live console you can type commands into
- Basic settings: name, RAM, MOTD, max players, port, difficulty
- Host a server from a CurseForge or Prism Launcher profile on this PC, so the server matches the game you play
- "How to join" screen: server addresses with copy buttons, the exact Minecraft/loader/mod versions players need, and in-game steps
- Check any CurseForge/Prism profile against a server (wrong loader version, missing mods)
- Export a server's client pack as a CurseForge-importable .zip, or as a .mrpack
- Client-only mods are left off the server, unless another mod requires them; Java is picked to satisfy both Minecraft and the mods

Planned next: playit.gg tunnel so friends can join without port forwarding, CurseForge modpack search, backups, and an installer build.

## Run it

Requires Node.js 20+ on Windows.

```bash
npm install
npm start
```

Server files, Java runtimes, and downloads are stored in `%APPDATA%\self-host-mc\data`.

## Engine smoke test

The server engine has no Electron dependency, so it can be tested from the command line. This installs a pack into `.dev-data/` and launches it up to the EULA prompt:

```bash
npm run test:engine -- "Cobblemon Official Modpack [Fabric]"
```

To build a server from a CurseForge/Prism profile on this PC the same way:

```bash
node scripts/profile-smoke.js "<profile name>"
```

## Layout

```
src/engine/    Server engine (plain Node): Modrinth, .mrpack install, Java, loaders, process
src/main/      Electron main process and preload bridge
src/renderer/  UI (plain HTML/CSS/JS)
scripts/       Dev scripts
```
