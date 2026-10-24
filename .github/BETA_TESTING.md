# Beta testing EZ Host

Thank you for testing. About 30 to 45 minutes is plenty, and you don't need to finish everything. Partial reports are useful too.

## Before you start
- Windows 10 or 11, and the game you'll host (Minecraft Java Edition and/or Project Zomboid).
- Get the installer from the [latest release](https://github.com/Ish-2601/EZ-Host/releases/latest). Windows may warn "Windows protected your PC" because the installer isn't signed yet; that's expected. Click **More info**, then **Run anyway**.

## What to try
1. Install it, open it, and go through the quick tour.
2. **Minecraft:** make a server (a profile you play, a Modrinth pack, or plain Minecraft), press **Start**, and join it from your game.
3. **Project Zomboid:** make a new server, pick a world preset, and set a name and max players. Start it (the first time downloads about 7 GB) and join.
4. Click **Connect playit.gg** (free) and ask a friend on a different network to join.
5. Look at the Players, Mods and Map or World tabs, and the App settings (try another theme).
6. Stop the server and start it again. Close the app and open it again.

## What to tell us
Open one issue per test using the **Beta tester report** form: [new report](https://github.com/Ish-2601/EZ-Host/issues/new/choose). Say what worked, what didn't, and what confused you. For problems, use **Something went wrong** and paste the Console text.

---

# For the maintainer: tracking testers and the SignPath application

## Track testers
- Create a GitHub **Project** (Projects tab, board layout) or one issue called "Beta testers" with a checklist. Each tester gets a row: GitHub name, date invited, date they reported, which game, outcome.
- Every report is a GitHub issue with the `beta-test` label, so **Issues filtered by that label is your list of testers**.
- Keep a short "What testers found" list in the release notes of each version, thanking testers by their GitHub name (only if they said yes to being named).
- Ask testers to **star** the repo if they liked it. Don't ask for stars from people who didn't try it.

## What counts as "reputation"
Real use by people you aren't related to. Strongest first:
1. Release download counts (GitHub shows them per file on the Releases page).
2. Issues and reports from different GitHub accounts.
3. Stars, forks and watchers (Insights tab, Traffic and Community).
4. Posts or videos about EZ Host, with links.
5. Quoted comments from testers (with permission).

Testers who are friends are fine for testing, but they count for little as reputation. Don't buy or trade for stars, downloads or reviews: it can get the application refused.

## Submit to SignPath Foundation
1. Merge and publish the Release first (with the code signing policy section in the README).
2. Make sure the Actions build on GitHub runs green on a tag push.
3. Open the application form at signpath.org and fill it in with the answers in the project thread. In **Reputation**, list the real numbers: downloads of the latest release, stars, number of testers who reported, and links to any posts.
4. Wait for their reply by email. They may ask questions, ask for more evidence or decline. If declined, ask what they'd need to see and apply again later.
5. If approved, they give you a SignPath organisation. Then add the SignPath step to `.github/workflows/build.yml` so the signed installer comes out of the build.
