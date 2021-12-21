const argsSchema = [
  ['github', 'alainbryden'],
  ['repository', 'bitburner-scripts'],
  ['branch', 'main'],
  ['download', []], // By default, all files returned by ns.ls() will be downloaded. Override with just a subset of files here
  ['new-file', []], // By default, only files returned by ns.ls() will be downloaded. You can add additional files to seek out here.
  ['subfolder', ''], // Can be set to download to a sub-folder that is not part of the remote repository structure
]
export function autocomplete(data, _) {
  data.flags(argsSchema);
  return [];
}

const filesToDownload = [
  '/Flags/deleting.txt',
  '/Remote/grow-target.js',
  '/Remote/hack-target.js',
  '/Remote/manualhack-target.js',
  '/Remote/weak-target.js',
  '/Tasks/backdoor-all-servers.js',
  '/Tasks/backdoor-all-servers.js.backdoor-one.js',
  '/Tasks/contractor.js',
  '/Tasks/contractor.js.solver.js',
  '/Tasks/program-manager.js',
  '/Tasks/ram-manager.js',
  '/Tasks/run-with-delay.js',
  '/Tasks/tor-manager.js',
  '/Tasks/write-file.js',
  'analyze-hack.js',
  'cascade-kill.js',
  'cleanup.js',
  'crime.js',
  'daemon.js',
  'faction-manager.js',
  'farm-intelligence.js',
  'gangs.js',
  'get-list.js',
  'git-pull.js',
  'hacknet-upgrade-manager.js',
  'helpers.js',
  'host-manager.js',
  'remove-worst-server.js',
  'reserve.js',
  'reserve.txt',
  'run-command.js',
  'scan.js',
  'sleeve.js',
  'spend-hacknet-hashes.js',
  'stats.js',
  'stockmaster.js',
  'work-for-factions.js',
  'playerservers.js',
]
const valuesToRemove = ['BB_SERVER_MAP']

function localeHHMMSS(ms = 0) {
  if (!ms) {
    ms = new Date().getTime()
  }

  return new Date(ms).toLocaleTimeString()
}

export async function main(ns) {
  ns.tprint(`[${localeHHMMSS()}] Starting initDaemon.js`)
  const options = ns.flags(argsSchema);
  const baseUrl = `https://raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`;
  let hostname = ns.getHostname()

  if (hostname !== 'home') {
    throw new Exception('Run the script from home')
  }

  for (let i = 0; i < filesToDownload.length; i++) {
    const filename = filesToDownload[i]
    const path = baseUrl + filename
    await ns.scriptKill(filename, 'home')
    await ns.rm(filename)
    await ns.sleep(200)
    ns.tprint(`[${localeHHMMSS()}] Trying to download ${path}`)
    await ns.wget(path + '?ts=' + new Date().getTime(), filename)
  }

  valuesToRemove.map((value) => localStorage.removeItem(value))

  ns.tprint(`[${localeHHMMSS()}] Spawning Daemon`)
  ns.spawn('daemon.js')
}
