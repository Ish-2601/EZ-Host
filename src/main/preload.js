// Exposes a small, explicit API to the UI. The renderer has no Node access.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  searchModpacks: invoke('modrinth:search'),
  getModpackVersions: invoke('modrinth:versions'),

  listServers: invoke('servers:list'),
  getServer: invoke('servers:get'),
  getConsole: invoke('servers:console'),
  createFromModrinth: invoke('servers:createFromModrinth'),
  createFromFile: invoke('servers:createFromFile'),
  acceptEula: invoke('servers:acceptEula'),
  start: invoke('servers:start'),
  stop: invoke('servers:stop'),
  command: invoke('servers:command'),
  update: invoke('servers:update'),
  getProperties: invoke('servers:properties'),
  setProperties: invoke('servers:setProperties'),
  deleteServer: invoke('servers:delete'),
  openFolder: invoke('servers:openFolder'),
  totalMemoryMb: invoke('system:totalMemoryMb'),
  copy: invoke('system:copy'),

  listProfiles: invoke('profiles:list'),
  createFromProfile: invoke('servers:createFromProfile'),
  checkProfile: invoke('servers:checkProfile'),
  joinInfo: invoke('servers:joinInfo'),
  clientNeeds: invoke('servers:clientNeeds'),
  exportClientPack: invoke('servers:exportClientPack'),
  exportMrpack: invoke('servers:exportMrpack'),
  onExport: subscribe('server:export'),

  playitStatus: invoke('playit:status'),
  playitLink: invoke('playit:link'),
  playitUnlink: invoke('playit:unlink'),
  playitRetry: invoke('playit:retry'),
  getPlayers: invoke('servers:players'),
  onPlayit: subscribe('playit:status'),
  onPlayers: subscribe('server:players'),
  getTunnel: invoke('servers:tunnel'),
  newAddress: invoke('servers:newAddress'),
  createVanilla: invoke('servers:createVanilla'),
  minecraftVersions: invoke('minecraft:versions'),
  openExternal: invoke('system:openExternal'),
  onTunnel: subscribe('server:tunnel'),
  pregenStatus: invoke('servers:pregen'),
  listPlayers: invoke('players:list'),
  mapDimensions: invoke('map:dimensions'),
  mapRegions: invoke('map:regions'),
  mapTile: invoke('map:tile'),
  mapPlayers: invoke('map:players'),
  mapForceloaded: invoke('map:forceloaded'),
  mapForceload: invoke('map:forceload'),
  playerDetails: invoke('players:details'),
  playerAction: invoke('players:action'),
  installChunky: invoke('servers:installChunky'),
  pregenStart: invoke('servers:pregenStart'),
  pregenPause: invoke('servers:pregenPause'),
  pregenContinue: invoke('servers:pregenContinue'),
  pregenCancel: invoke('servers:pregenCancel'),
  onPregen: subscribe('server:pregen'),

  onConsole: subscribe('server:console'),
  onStatus: subscribe('server:status'),
  onInstall: subscribe('server:install'),
  onServersChanged: subscribe('servers:changed'),
});
