// Every option in <servername>.ini, with the description the game writes above
// it ("# Players can hurt ... Min: 0 Max: 1000 Default: 2"), grouped for the editor.
const fs = require('fs');

// Set by the app on every start (ports, RCON, mods); never shown in the editor.
const MANAGED = new Set(['DefaultPort', 'UDPPort', 'RCONPort', 'RCONPassword', 'Mods', 'WorkshopItems', 'UPnP', 'ResetID', 'ServerPlayerID']);

const GROUPS = [
  ['Joining and the server list', /^(Public|PublicName|PublicDescription|Password|MaxPlayers|Open|AutoCreateUserInWhiteList|MaxAccountsPerUser|DenyLoginOnOverloadedServer|LoginQueue|PingLimit|AllowCoop|AllowNonAsciiUsername|ServerWelcomeMessage|SteamScoreboard|Map|DropOffWhiteListAfterDeath|KickFastPlayers|DisableScoreboard|HideAdminsInPlayerList|server_browser|MultiplayerStatistics)/],
  ['World', /^(PauseEmpty|Seed|War|SwitchZombiesOwnership)/],
  ['PvP and safety', /^(PVP|Safety|ShowSafety|SafetySystem|PVPMelee|PVPFirearm|PvpTrue)/],
  ['Players', /^(Display|ShowFirst|Username|HideDisguised|Spawn|PlayerRespawn|SleepAllowed|SleepNeeded|Mouse|AllowDestructionBySledgehammer|SledgehammerOnlyInSafehouse|PlayerSaveOnDamage|NoFire|MinutesPerPage|AnnounceDeath|BloodSplatLifespanDays|KnockedDown|SneakMode|PlayerBump|HidePlayersBehindYou|ShowCoordinates|UsePhysicsHitReaction|PerkLogs|Announce|UltraSpeed)/],
  ['Vehicles', /(Towing|Vehicle)/],
  ['Chat and voice', /^(GlobalChat|ChatStreams|Voice|DisableRadio|DiscordEnable|DiscordToken|Discord|Webhook|BadWord|GoodWord|ChatMessage)/],
  ['Safehouses', /^(Safehouse|PlayerSafehouse|AdminSafehouse|SafeHouse|DisableSafehouse|AllowTrespass|SafehouseAllow|SafehouseDaysSurvived|SafehouseRemoval|SafehouseDisable|MaxSafezoneSize)/i],
  ['Factions', /^Faction/],
  ['Loot and items', /^(HoursForLootRespawn|MaxItemsForLootRespawn|ConstructionPreventsLootRespawn|ItemNumbersLimitPerContainer|TrashDeleteAll|ItemTransfer|BanKickGlobalSound|NoFireSpread|RemovePlayerCorpsesOnCorpseRemoval|CarEngine|Loot)/],
  ['Saving and backups', /^(SaveWorldEveryMinutes|Backup|ServerSaveInterval|PlayerSaveOnDamage)/],
  ['Anti-cheat', /^(AntiCheat|SteamVAC|DoLuaChecksum|MaxPacketsPerSecond)/],
  ['Performance', /^(SpeedLimit|PhysicsDelay|FastForward|ZombieUpdate|LightingFPS|WorldItemRemoval|HoursForWorldItemRemoval|ItemRemoval|Max(Zombie|Item)|Client|Server(Player|Fps))/],
];

function groupOf(key) {
  for (const [name, re] of GROUPS) if (re.test(key)) return name;
  return 'Other';
}

/** [{ key, group, type ('bool'|'number'|'text'), value, help, min?, max?, def?, decimal? }] */
function parseServerOptions(text) {
  const fields = [];
  let comments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      comments = [];
      continue;
    }
    if (line.startsWith('#')) {
      comments.push(line.replace(/^#\s?/, ''));
      continue;
    }
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1);
    const help = comments.join(' ');
    comments = [];
    if (MANAGED.has(key)) continue;
    const range = help.match(/Min:\s*(-?[\d.]+)\s*Max:\s*(-?[\d.]+)(?:\s*Default:\s*(-?[\d.]+))?/i);
    const type = value === 'true' || value === 'false' ? 'bool' : range && /^-?\d+(\.\d+)?$/.test(value) ? 'number' : 'text';
    fields.push({
      key,
      group: groupOf(key),
      type,
      value: type === 'bool' ? value === 'true' : type === 'number' ? Number(value) : value,
      decimal: type === 'number' && (value.includes('.') || (range && range[1].includes('.'))),
      label: key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'),
      help: help.replace(/\s*Min:.*$/i, '').trim(),
      min: range ? Number(range[1]) : undefined,
      max: range ? Number(range[2]) : undefined,
      def: range && range[3] !== undefined ? range[3] : undefined,
    });
  }
  return fields;
}

function readServerOptions(file) {
  if (!fs.existsSync(file)) return null;
  return parseServerOptions(fs.readFileSync(file, 'utf8'));
}

/** Clean values for writeIni: known keys only, numbers clamped, no line breaks. */
function cleanServerOptions(file, values) {
  const fields = new Map((readServerOptions(file) || []).map((f) => [f.key, f]));
  const patch = {};
  for (const [key, raw] of Object.entries(values || {})) {
    const f = fields.get(key);
    if (!f) continue;
    if (f.type === 'bool') patch[key] = raw === true || raw === 'true' ? 'true' : 'false';
    else if (f.type === 'number') {
      let n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (f.min !== undefined) n = Math.max(f.min, n);
      if (f.max !== undefined) n = Math.min(f.max, n);
      patch[key] = f.decimal ? String(n) : String(Math.round(n));
    } else patch[key] = String(raw).replace(/[\r\n]/g, ' ').slice(0, 4000);
  }
  return patch;
}

module.exports = { parseServerOptions, readServerOptions, cleanServerOptions, MANAGED };
