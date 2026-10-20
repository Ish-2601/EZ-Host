// Project Zomboid mods on a server: which Workshop mods are on (the Mods= and
// WorkshopItems= lines of the server's .ini), turning them on and off, and
// spotting problems (missing requirements, incompatible pairs, mods the
// server cannot download).
const { readIni, writeIni, splitList, joinList, scanWorkshop } = require('./config');

/**
 * Overview for the Mods tab.
 * Returns { items: [{ workshopId, title, mods: [{ id, name, enabled, problems }] }], problems, enabledCount }
 */
function overview(iniFile, workshop = scanWorkshop()) {
  const ini = readIni(iniFile);
  const enabled = splitList(ini.Mods);
  const enabledSet = new Set(enabled);
  const workshopItems = new Set(splitList(ini.WorkshopItems));

  const modToItem = new Map();
  const modInfo = new Map();
  for (const item of workshop) {
    for (const m of item.mods) {
      if (!modToItem.has(m.id)) modToItem.set(m.id, item.workshopId);
      if (!modInfo.has(m.id)) modInfo.set(m.id, m);
    }
  }

  const problems = [];
  const problemsFor = new Map();
  const add = (modId, text) => {
    problems.push({ modId, text });
    if (!problemsFor.has(modId)) problemsFor.set(modId, []);
    problemsFor.get(modId).push(text);
  };
  for (const id of enabled) {
    const info = modInfo.get(id);
    const item = modToItem.get(id);
    // Mods missing from the host's own Workshop downloads are listed separately
    // (they may still download fine on the server); they are not problems.
    if (info && item && !workshopItems.has(item)) {
      add(id, 'Its Workshop item is not in the server\'s download list, so the server cannot get it.');
    }
    if (info) {
      for (const req of info.require) {
        if (!enabledSet.has(req)) add(id, `Needs "${(modInfo.get(req) || {}).name || req}", which is turned off.`);
      }
      for (const bad of info.incompatible) {
        if (enabledSet.has(bad)) add(id, `Does not work together with "${(modInfo.get(bad) || {}).name || bad}".`);
      }
    }
  }

  const items = workshop.map((item) => ({
    workshopId: item.workshopId,
    title: item.title,
    inDownloadList: workshopItems.has(item.workshopId),
    mods: item.mods.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: enabledSet.has(m.id),
      problems: problemsFor.get(m.id) || [],
    })),
  }));
  // Mods that are on but not in the host's Workshop downloads.
  const unknown = enabled.filter((id) => !modInfo.has(id));
  return { items, unknown, problems, enabledCount: enabled.length, workshopCount: workshopItems.size };
}

/**
 * Turn one mod on or off. Turning a mod on also adds what it requires (when
 * known) and its Workshop item to the download list; load order is kept.
 */
function setModEnabled(iniFile, modId, enabled, workshop = scanWorkshop()) {
  const ini = readIni(iniFile);
  const mods = splitList(ini.Mods);
  const items = splitList(ini.WorkshopItems);
  const modInfo = new Map();
  const modToItem = new Map();
  for (const item of workshop) {
    for (const m of item.mods) {
      if (!modInfo.has(m.id)) modInfo.set(m.id, m);
      if (!modToItem.has(m.id)) modToItem.set(m.id, item.workshopId);
    }
  }
  const added = [];
  if (enabled) {
    const queue = [modId];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      // Requirements load before the mods that need them.
      const info = modInfo.get(id);
      if (info) queue.push(...info.require);
      if (!mods.includes(id)) {
        mods.push(id);
        if (id !== modId) added.push((info && info.name) || id);
      }
      const item = modToItem.get(id);
      if (item && !items.includes(item)) items.push(item);
    }
    // Move requirements in front of the mod that needs them.
    const order = (id, stack = new Set()) => {
      if (stack.has(id)) return [];
      stack.add(id);
      const info = modInfo.get(id);
      return [...(info ? info.require.flatMap((r) => order(r, stack)) : []), id];
    };
    const wanted = order(modId).filter((id) => mods.includes(id));
    const rest = mods.filter((id) => !wanted.includes(id));
    const at = rest.length;
    mods.splice(0, mods.length, ...rest.slice(0, at), ...wanted);
  } else {
    const i = mods.indexOf(modId);
    if (i >= 0) mods.splice(i, 1);
    // Drop the Workshop item if none of its mods are still on.
    const item = modToItem.get(modId);
    if (item) {
      const stillUsed = mods.some((id) => modToItem.get(id) === item);
      if (!stillUsed) items.splice(items.indexOf(item), items.includes(item) ? 1 : 0);
    }
  }
  writeIni(iniFile, { Mods: joinList(mods), WorkshopItems: joinList(items) });
  return { added };
}

module.exports = { overview, setModEnabled };
