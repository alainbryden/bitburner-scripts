const settings = {
  maxPlayerServers: 25,
  gbRamCost: 55000,
  maxGbRam: 1048576,
  minGbRam: 64,
  totalMoneyAllocation: 0.9,
  actions: {
    BUY: 'buy',
    UPGRADE: 'upgrade',
  },
  keys: {
    serverMap: 'BB_SERVER_MAP',
  },
}

function getItem(key) {
  let item = localStorage.getItem(key)

  return item ? JSON.parse(item) : undefined
}

function setItem(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function localeHHMMSS(ms = 0) {
  if (!ms) {
    ms = new Date().getTime()
  }

  return new Date(ms).toLocaleTimeString()
}

function createUUID() {
  var dt = new Date().getTime()
  var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (dt + Math.random() * 16) % 16 | 0
    dt = Math.floor(dt / 16)
    return (c == 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
  return uuid
}

function updateServer(ns, serverMap, host) {
  serverMap.servers[host] = {
    host,
    ports: ns.getServerNumPortsRequired(host),
    hackingLevel: ns.getServerRequiredHackingLevel(host),
    maxMoney: ns.getServerMaxMoney(host),
    growth: ns.getServerGrowth(host),
    minSecurityLevel: ns.getServerMinSecurityLevel(host),
    baseSecurityLevel: ns.getServerBaseSecurityLevel(host),
    ram: ns.getServerRam(host)[0],
    connections: ['home'],
    parent: 'home',
    children: [],
  }

  Object.keys(serverMap.servers).map((hostname) => {
    if (!ns.serverExists(hostname)) {
      delete serverMap.servers[hostname]
    }
  })

  setItem(settings.keys.serverMap, serverMap)
}

function getPurchasedServers(ns) {
  let purchasedServers = ns.getPurchasedServers()
  if (purchasedServers.length) {
    purchasedServers.sort((a, b) => {
      const totalRamA = ns.getServerRam(a).shift()
      const totalRamB = ns.getServerRam(b).shift()

      if (totalRamA === totalRamB) {
        return ns.getServerRam(a).shift() - ns.getServerRam(b).shift()
      } else {
        return totalRamA - totalRamB
      }
    })
  }

  return purchasedServers
}

export async function main(ns) {
  ns.tprint(`[${localeHHMMSS()}] Starting playerServers.ns`)

  settings.maxGbRam = ns.getPurchasedServerMaxRam()
  settings.maxPlayerServers = ns.getPurchasedServerLimit()
  let hostname = ns.getHostname()

  if (hostname !== 'home') {
    throw new Exception('Run the script from home')
  }

  while (true) {
    let didChange = false

    const serverMap = getItem(settings.keys.serverMap)
    let purchasedServers = getPurchasedServers(ns)

    let action = purchasedServers.length < settings.maxPlayerServers ? settings.actions.BUY : settings.actions.UPGRADE

    if (action == settings.actions.BUY) {
      let smallestCurrentServer = purchasedServers.length ? ns.getServerRam(purchasedServers[0]).shift() : 0
      let targetRam = Math.max(settings.minGbRam, smallestCurrentServer)

      if (targetRam === settings.minGbRam) {
        while (ns.getServerMoneyAvailable('home') * settings.totalMoneyAllocation >= targetRam * settings.gbRamCost * settings.maxPlayerServers) {
          targetRam *= 2
        }

        targetRam /= 2
      }

      targetRam = Math.max(settings.minGbRam, targetRam)
      targetRam = Math.min(targetRam, settings.maxGbRam)

      if (ns.getServerMoneyAvailable('home') * settings.totalMoneyAllocation >= targetRam * settings.gbRamCost) {
        let hostname = `pserv-${targetRam}-${createUUID()}`
        hostname = ns.purchaseServer(hostname, targetRam)

        if (hostname) {
          ns.tprint(`[${localeHHMMSS()}] Bought new server: ${hostname} (${targetRam} GB)`)

          updateServer(ns, serverMap, hostname)
          didChange = true
        }
      }
    } else {
      let smallestCurrentServer = Math.max(ns.getServerRam(purchasedServers[0]).shift(), settings.minGbRam)
      let biggestCurrentServer = ns.getServerRam(purchasedServers[purchasedServers.length - 1]).shift()
      let targetRam = biggestCurrentServer

      if (smallestCurrentServer === settings.maxGbRam) {
        ns.tprint(`[${localeHHMMSS()}] All servers maxxed. Exiting.`)
        ns.exit()
        return
      }

      if (smallestCurrentServer === biggestCurrentServer) {
        while (ns.getServerMoneyAvailable('home') * settings.totalMoneyAllocation >= targetRam * settings.gbRamCost) {
          targetRam *= 4
        }

        targetRam /= 4
      }

      targetRam = Math.min(targetRam, settings.maxGbRam)

      purchasedServers = getPurchasedServers(ns)
      if (targetRam > ns.getServerRam(purchasedServers[0]).shift()) {
        didChange = true
        while (didChange) {
          didChange = false
          purchasedServers = getPurchasedServers(ns)

          if (targetRam > ns.getServerRam(purchasedServers[0]).shift()) {
            if (ns.getServerMoneyAvailable('home') * settings.totalMoneyAllocation >= targetRam * settings.gbRamCost) {
              let hostname = `pserv-${targetRam}-${createUUID()}`

              await ns.killall(purchasedServers[0])
              await ns.sleep(10)
              const serverDeleted = await ns.deleteServer(purchasedServers[0])
              if (serverDeleted) {
                hostname = await ns.purchaseServer(hostname, targetRam)

                if (hostname) {
                  ns.tprint(`[${localeHHMMSS()}] Upgraded: ${purchasedServers[0]} into server: ${hostname} (${targetRam} GB)`)

                  updateServer(ns, serverMap, hostname)
                  didChange = true
                }
              }
            }
          }
        }
      }
    }

    if (!didChange) {
      await ns.sleep(5123)
    }
  }
}
