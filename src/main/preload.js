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

  onConsole: subscribe('server:console'),
  onStatus: subscribe('server:status'),
  onInstall: subscribe('server:install'),
  onServersChanged: subscribe('servers:changed'),
});
