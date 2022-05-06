import { log } from './helpers'

const win = [].map.constructor('return this')()
const doc = win.document

let _ns

/** @param {import(".").NS} ns */
export async function main (ns) {
  _ns = ns
  _ns.disableLog('ALL')
  _ns.tail()
  try {
    await mainLoop()
  } catch (err) {
    log(_ns, err.toString())
    throw err
  }
}

async function mainLoop () {
  let canceled = false
  const cancelHook = function () {
    const btn = [...doc.getElementsByTagName('button')].find(e => e.innerText.includes('Cancel Infiltration'))
    if (!btn) return
    const fn = btn.onclick
    if (fn._hooked) return
    btn.onclick = () => { canceled = true; fn() }
    btn.onclick._hooked = true
  }
  /* eslint-disable-next-line no-unmodified-loop-condition */
  while (!canceled) {
    let fail = false
    if (!ensureAevum()) {
      log(_ns, 'ERROR: Could not find ECorp in Aevum.')
      break
    }
    await _ns.asleep(0)
    getEcorp().click()
    clickTrusted(queryFilter('button', 'Infil'))
    log(_ns, 'Started loop')
    while (!infiltrationComplete()) {
      await _ns.asleep(1000)
      cancelHook()
      if (getEcorp()) {
        // booted to city!
        fail = true
        break
      }
      if (canceled) {
        break
      }
      // log(ns, 'Waiting')
    }
    if (fail) {
      continue
    }
    const sellBtn = queryFilter('button', 'Sell')
    log(_ns, `Selling for ${sellBtn?.innerText.split('\n').at(-1)}`)
    sellBtn?.click()
    await _ns.asleep(1000)
  }
}

function queryFilter (query, filter) {
  return [...doc.querySelectorAll(query)].find(e => e.innerText.trim().match(filter))
}

function ensureAevum () {
  if (_ns.getPlayer().city !== 'Aevum' && !_ns.travelToCity('Aevum')) {
    log(_ns, 'ERROR: Sorry, you need at least $200k to travel.')
    return false
  }
  queryFilter('p', 'City')?.click()
  if (getEcorp() === null) {
    // another script probably called travelToCity and the UI got stuck, so force a redraw
    log(_ns, 'WARN: Player is in Aevum, but ECorp could not be located. Forcing a redraw...')
    queryFilter('p', 'Terminal')?.click()
    queryFilter('p', 'City')?.click()
  }
  if (getEcorp() === null) {
    // if that didn't work, just abort
    return false
  }
  return true
}

function getEcorp () {
  return doc.querySelector('[aria-label="ECorp"]')
}

function clickTrusted (node) {
  const handler = Object.keys(node)[1]
  node[handler].onClick({ isTrusted: true })
}

function infiltrationComplete () {
  const ret = queryFilter('h4', 'Infiltration successful!') !== undefined
  console.log(`infiltrationComplete() returning ${ret}`)
  return ret
}
