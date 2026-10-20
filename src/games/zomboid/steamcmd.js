// SteamCMD: Valve's command-line Steam client, used to install and update
// dedicated servers (Project Zomboid is app 380870) with an anonymous login.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { download } = require('../../engine/http');

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

/** Check that steamcmd.exe is signed by Valve before running it (Windows only). */
function verifyValveSignature(exe) {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, out) => {
      if (err) return reject(err);
      const [status, subject = ''] = out.trim().split('|');
      if (status === 'Valid' && /CN=Valve\b/.test(subject)) resolve();
      else reject(new Error(`SteamCMD failed its signature check (${status})`));
    })
  );
}

/** Download SteamCMD into `dir` the first time. Returns the path to steamcmd.exe. */
async function ensureSteamCmd(dir, log = () => {}) {
  if (process.platform !== 'win32') throw new Error('Hosting Project Zomboid is only supported on Windows for now');
  const exe = path.join(dir, 'steamcmd.exe');
  if (fs.existsSync(exe)) return exe;
  await fsp.mkdir(dir, { recursive: true });
  log('Downloading SteamCMD (Valve\'s tool for installing game servers)...');
  const zipFile = path.join(dir, 'steamcmd.zip');
  await download(STEAMCMD_URL, zipFile);
  new AdmZip(zipFile).extractAllTo(dir, true);
  await fsp.rm(zipFile, { force: true });
  try {
    await verifyValveSignature(exe);
  } catch (err) {
    await fsp.rm(exe, { force: true });
    throw err;
  }
  return exe;
}

/**
 * Install or update a Steam app with SteamCMD. `onProgress(percent, label)`
 * follows SteamCMD's own progress lines.
 */
function appUpdate(steamcmd, installDir, appId, { onProgress = () => {}, log = () => {}, validate = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId)];
    if (validate) args.push('validate');
    args.push('+quit');
    const child = spawn(steamcmd, args, { cwd: path.dirname(steamcmd), windowsHide: true });
    let success = false;
    let lastError = null;
    let buffer = '';
    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const progress = line.match(/Update state \(0x[0-9a-f]+\) (\w[\w ]*?), progress: ([\d.]+)/i);
        if (progress) {
          onProgress(Number(progress[2]), progress[1].replace(/^\w/, (c) => c.toUpperCase()));
          continue;
        }
        if (/Success! App '\d+' (fully installed|already up to date)/i.test(line)) success = true;
        if (/^ERROR!|Error! App/i.test(line)) lastError = line;
        if (/Steam Console Client|Loading Steam API|Connecting anonymously|Waiting for|Logged in|Success|ERROR|Update state/i.test(line)) log(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      // SteamCMD exits with 7 after updating itself on the first run; that is fine if the app installed.
      if (success) resolve();
      else reject(new Error(lastError || `SteamCMD stopped with code ${code}`));
    });
  });
}

module.exports = { ensureSteamCmd, appUpdate };
