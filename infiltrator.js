/* infiltrator.js
 * Fully-automated infiltrator: just add a tiny 11-line python service running on the host.
 * This uses a simple paradigm I like to call "services": zero-RAM tasks running almost-invisibly via setInterval.
 * Information on running services is stored in the local file `services.txt`.
 * Running this file will launch the service (killing any previous instances), store its info, and quickly exit.
 * Running this file with --kill will just kill the old one.
 * TODO: Add support for starting/finishing infiltrations automatically
 * TODO: restore partial functionality for when key server is disconnected (human assistance mode)
 * TODO: separate out services logic into a `services.js` so more can be easily added (e.g. terminal monitor)
 */

import { runCommand, log } from './helpers.js'

// delays for setTimeout and setInterval above this threshold are not modified
// (helps prevent issues with hacking scripts)
const maxDelayCutoff = 30e3

// interval multiplier to apply during infiltrations (set to 1 to disable)
const infiltrationTimeFactor = 0.55

// interval to check for infiltration/game updates
const tickInterval = 50

// URL to connect to local keypress server
const socketUrl = 'ws://localhost:59764'

// unique name to prevent overlaps
const serviceName = 'infiltrator'

let _win = [].map.constructor('return this')()
let _doc = [].map.constructor('return this.document')()

const argsSchema = [
  ['kill', false] // stop the old service, don't start a new one
]

// log to console with prefix and no spamming
let lastLog
function logConsole (str) {
  if (str === lastLog) return
  console.log('infiltrator.js: ' + str)
  lastLog = str
}

// straight replacement for ns.asleep
function sleep (time) {
  return new Promise(resolve => setTimeout(() => resolve(true), time))
}

function addCss () {
  const css = `<style id="infilCss">
  @keyframes rgPulse {
    0% { color: #f00 }
    100% { color: #0f0 }
  }
  .infiltrationEnabled {
    animation-name: rgPulse;
    animation-duration: 1s;
    animation-iteration-count: infinite;
    animation-direction: alternate
  }
  </style>`
  _doc.getElementById('infilCss')?.remove()
  _doc.head.insertAdjacentHTML('beforeend', css);
}

function infilButtonUpdate() {
  const node = [..._doc.getElementsByTagName('BUTTON')].find(e => e.innerText === 'Infiltrate Company')
  node?.classList.add('infiltrationEnabled')
}

// compress/stretch setInterval and setTimeout, to make infiltrations easier
// for a human or faster if fully automated.
// return true if anything was changed.
let lastFactor = 1
function setTimeFactor (factor = 1) {
  // backup native functions if necessary
  if (_win._setTimeout === undefined) { _win._setTimeout = _win.setTimeout }
  if (_win._setInterval === undefined) { _win._setInterval = _win.setInterval }
  // return early if possible
  if (factor === lastFactor) return false
  // if factor is 1, don't bother wrapping
  if (factor === 1) {
    _win.setTimeout = _win._setTimeout
    _win.setInterval = _win._setInterval
    lastFactor = factor
    return true
  }
  // wrap setTimeout and setInterval
  _win.setTimeout = function (fn, delay, ...args) {
    if (delay < maxDelayCutoff) {
      _win._setTimeout(fn, Math.round(delay * factor), ...args)
    } else {
      _win._setTimeout(fn, delay, ...args)
    }
  }
  _win.setInterval = function (fn, delay, ...args) {
    if (delay < maxDelayCutoff) {
      _win._setInterval(fn, Math.round(delay * factor), ...args)
    } else {
      _win._setInterval(fn, delay, ...args)
    }
  }
  lastFactor = factor
  return true
}

function autoSetTimeFactor () {
  const levelElement = [..._doc.querySelectorAll('p')].filter(el => el.innerText.trim()
    .match(/^Level:\s+\d+\s*\/\s*\d+$/))

  if (levelElement.length === 0) {
    if (setTimeFactor(1)) {
      logConsole('Infiltration not detected: removing injection')
    }
  } else {
    if (setTimeFactor(infiltrationTimeFactor)) {
      logConsole('Infiltration detected: injecting middleware')
    }
  }
}

// navigation functions for MinesweeperGame and Cyberpunk2077Game
function getPathSingle (sizeX, sizeY, startPt, endPt) {
  const size = [sizeX, sizeY]
  // handle wrapping
  for (let i = 0; i <= 1; i++) {
    if (Math.abs(startPt[i] - endPt[i]) > size[i] / 2) {
      // shove either startPt or endPt past bounds so it moves backwards and wraps around
      if (startPt[i] < endPt[i]) startPt[i] += size[i]
      else endPt[i] += size[i]
    }
  }
  let ret = ''
  // calculate x offset
  if (startPt[0] < endPt[0]) ret += 'd'.repeat(endPt[0] - startPt[0])
  else ret += 'a'.repeat(startPt[0] - endPt[0])
  // calculate y offset
  if (startPt[1] < endPt[1]) ret += 's'.repeat(endPt[1] - startPt[1])
  else ret += 'w'.repeat(startPt[1] - endPt[1])
  return ret
}

function getPathSequential (sizeX, sizeY, points, start = [0, 0]) {
  const ret = []
  const routePoints = [start, ...points]
  for (let i = 0; i < routePoints.length - 1; i++) {
    ret.push(getPathSingle(sizeX, sizeY, routePoints[i], routePoints[i + 1]))
  }
  return ret
}

function getGridX (node) {
  let x = 0
  while (node.previousSibling !== null) {
    node = node.previousSibling
    x += 1
  }
  return x
}

function getGridY (node) {
  let y = 0
  node = node.parentNode.parentNode
  while (node.previousSibling?.tagName === 'DIV') {
    node = node.previousSibling
    y += 1
  }
  return y
}

class InfiltrationService {
  constructor (ns) {
    const self = this
    /* eslint-disable no-undef */
    self.ws = new WebSocket(socketUrl)
    /* eslint-enable */
    self.ws.onopen = () => {
      self.automationEnabled = true
      logConsole('Websocket connection established: full automation enabled.')
    }
    self.ws.onerror = event => {
      self.automationEnabled = false
      logConsole(`Warning: websocket is not connected: ${JSON.stringify(event)}`)
    }
    addCss()
    self.tickComplete = true
  }

  markSolution () {

  }

  clearSolution() {

  }

  async cyberpunk () {
    const getTargetElement = () => [..._doc.querySelectorAll('h5')].filter(e => e.innerText.includes('Targets:'))[0]
    let targetElement = getTargetElement()
    if (!targetElement) return
    logConsole('Game active: Cyberpunk2077 game')
    const targetValues = targetElement.innerText.split('Targets: ')[1].trim().split(/\s+/)
    const routePoints = []
    let size
    // get coords of each target
    for (const target of targetValues) {
      const node = [...targetElement.parentElement.querySelectorAll('div p span')].filter(el => el.innerText.trim() === target)[0]
      size = node.parentNode.childElementCount
      routePoints.push([getGridX(node), getGridY(node)])
    }
    const pathStr = getPathSequential(size, size, routePoints).join(' ') + ' '
    logConsole(`Sending path: '${pathStr}'`)
    this.ws.send(pathStr)
    while (targetElement !== undefined) {
      await sleep(100 / infiltrationTimeFactor)
      targetElement = getTargetElement()
    }
  }

  async oldMines () {
    const minePlots = [..._doc.querySelectorAll('span')].filter(el => el.innerText.trim().match(/^\[[X.\s?]\]$/))
    if (minePlots.length === 0) return
    logConsole('Game active: Minesweeper game')
    // outline mines
    minePlots.filter(el => el.innerText.trim().match(/^\[\?\]$/)).forEach(function (el) { el.style.outline = '2px red solid' })
    // remove outline from marked mines
    minePlots.filter(el => el.innerText.trim().match(/^\[\.\]$/)).forEach(function (el) { el.style.outline = '' })
  }

  async mines () {
    const isMemoryPhase = () => [..._doc.querySelectorAll('h4')].some(e => e.innerText === 'Remember all the mines!')
    const isMarkPhase = () => [..._doc.querySelectorAll('h4')].some(e => e.innerText === 'Mark all the mines!')
    if (!isMemoryPhase()) return
    logConsole('Game active: Minesweeper game')
    const gridElements = [..._doc.querySelectorAll('span')].filter(el => el.innerText.trim().match(/^\[[X.\s?]\]$/))
    if (gridElements.length === 0) return
    // get size
    const sizeX = gridElements[0].parentNode.childElementCount
    const sizeY = gridElements[0].parentNode.parentNode.parentNode.childElementCount
    // get coordinates for each mine
    const mineCoords = gridElements.filter(el => el.innerText.trim().match(/^\[\?\]$/)).map(el => [getGridX(el), getGridY(el)])
    // wait for mark phase
    while (isMemoryPhase()) {
      await sleep(100 / infiltrationTimeFactor)
    }
    // send solution string
    const pathStr = getPathSequential(sizeX, sizeY, mineCoords).join(' ') + ' '
    logConsole(`Mine solution string: ${pathStr}`)
    this.ws.send(pathStr)
    // wait for end
    while (isMarkPhase()) {
      await sleep(100 / infiltrationTimeFactor)
    }
  }

  async slash () {
    const self = this
    if (!self.automationEnabled) return
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText === 'Slash when his guard is down!')[0]
    let activeElement = getActiveElement()
    while (activeElement !== undefined) {
      logConsole('Game active: Slash game')
      if (activeElement.nextSibling.innerText === 'ATTACKING!') {
        self.ws.send(' ')
      }
      await sleep(50 / infiltrationTimeFactor)
      activeElement = getActiveElement()
    }
  }

  async brackets () {
    const self = this
    if (!self.automationEnabled) return
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText === 'Close the brackets')[0]
    let activeElement = getActiveElement()
    if (activeElement === undefined) return
    logConsole('Game active: Bracket game')
    const bracketText = activeElement.nextSibling.innerText
    const closeText = bracketText.split('').reverse().join('')
      .replaceAll('<', '>')
      .replaceAll('(', ')')
      .replaceAll('[', ']')
      .replaceAll('{', '}')
    self.ws.send(closeText)
    while (activeElement !== undefined) {
      activeElement = getActiveElement()
      await sleep(100 / infiltrationTimeFactor)
    }
  }

  async cheatCode () {
    const self = this
    if (!self.automationEnabled) return
    const arrowsMap = { '↑': 'w', '→': 'd', '↓': 's', '←': 'a' }
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText === 'Enter the Code!')[0]
    let activeElement = getActiveElement()
    let lastArrow
    while (activeElement !== undefined) {
      logConsole('Game active: Cheat Code game')
      const arrow = activeElement?.nextSibling?.innerText
      if (arrow !== lastArrow) {
        if (arrow in arrowsMap) {
          self.ws.send(arrowsMap[arrow])
          // logConsole(`Sent '${arrowsMap[arrow]}'`)
          lastArrow = arrow
        } else {
          return
        }
      }
      activeElement = getActiveElement()
      await sleep(50 / infiltrationTimeFactor)
    }
  }

  async backwardGame () {
    const self = this
    if (!self.automationEnabled) return
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText === 'Type it backward')[0]
    let activeElement = getActiveElement()
    if (activeElement === undefined) return
    logConsole('Game active: Backward game')
    const text = activeElement.parentNode.nextSibling.children[0].innerText
    self.ws.send(text.toLowerCase())
    while (activeElement !== undefined) {
      activeElement = getActiveElement()
      await sleep(100 / infiltrationTimeFactor)
    }
  }

  async bribeGame () {
    const self = this
    if (!self.automationEnabled) return
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText === 'Say something nice about the guard.')[0]
    let activeElement = getActiveElement()
    // if (activeElement === undefined) return
    let lastWord
    const positive = [
      'affectionate',
      'agreeable',
      'bright',
      'charming',
      'creative',
      'determined',
      'energetic',
      'friendly',
      'funny',
      'generous',
      'polite',
      'likable',
      'diplomatic',
      'helpful',
      'giving',
      'kind',
      'hardworking',
      'patient',
      'dynamic',
      'loyal'
    ]
    while (activeElement !== undefined) {
      logConsole('Game active: Bribe game')
      const currentWord = activeElement.parentNode.nextSibling.children[1].innerText
      if (positive.includes(currentWord)) {
        self.ws.send(' ')
      } else if (lastWord !== currentWord) {
        self.ws.send('w')
        lastWord = currentWord
      }
      activeElement = getActiveElement()
      await sleep(50 / infiltrationTimeFactor)
    }
  }

  async wireCuttingGame () {
    const self = this
    if (!self.automationEnabled) return
    const getActiveElement = () => [..._doc.querySelectorAll('h4')].filter(e => e.innerText.includes('Cut the wires'))[0]
    const activeElement = getActiveElement()
    if (activeElement === undefined) return
    logConsole('Game active: Wire Cutting game')
    // extract hints
    const hints = [...activeElement.parentNode.children].filter(el => el.tagName === 'P').map(el => el.innerText).join('')
    const colorHints = hints.match(/(?<=colored ).+?(?=\.)/g)
      .map(s => { return { white: 'white', blue: 'blue', red: 'red', yellow: 'rgb(255, 193, 7)' }[s] })
    const numberHints = hints.match(/(?<=number ).+?(?=\.)/g)
    const solution = new Set()
    numberHints.forEach(n => { solution.add(n) })
    // find the first div containing wire spans
    let wireDiv = activeElement
    while (wireDiv.tagName !== 'DIV') {
      wireDiv = wireDiv.nextSibling
    }
    // check first row of wire spans
    const wireCount = wireDiv.firstElementChild.childElementCount
    for (let i = 0; i < wireCount; i++) {
      if (colorHints.includes(wireDiv.firstElementChild.children[i].style.color)) {
        solution.add((i + 1).toString())
      }
    }
    // repeat for second row
    wireDiv = wireDiv.nextSibling
    for (let i = 0; i < wireCount; i++) {
      if (colorHints.includes(wireDiv.firstElementChild.children[i].style.color)) {
        solution.add((i + 1).toString())
      }
    }
    // send solution string
    const solutionStr = Array.from(solution).join('')
    logConsole(`Sending solution: ${solutionStr}`)
    this.ws.send(solutionStr)
    // wait for end
    while (getActiveElement() !== undefined) {
      await sleep(100 / infiltrationTimeFactor)
    }
  }

  async tick () {
    const self = this
    // prevent overlapping execution
    if (!self.tickComplete) return
    self.tickComplete = false
    // Add visual indicator to infiltration screen
    infilButtonUpdate()
    // Adjust time speed if we're infiltrating
    autoSetTimeFactor()
    // Match the symbols!
    await self.cyberpunk()
    // Mark all the mines!
    await self.mines()
    // Slash when his guard is down!
    await self.slash()
    // Close the brackets
    await self.brackets()
    // Enter the code
    await self.cheatCode()
    // Type it backward
    await self.backwardGame()
    // Say something nice about the guard
    await self.bribeGame()
    // Cut the wires
    await self.wireCuttingGame()
    // allow this function to be executed again
    self.tickComplete = true
  }

  start() {
    const self = this
    // ensure that _setInterval gets set first
    setTimeFactor(1)
    // use _setInterval instead of setInterval to guarantee no time fuckery
    self.intId = _win._setInterval(self.tick.bind(self), tickInterval)
    return self.intId
  }
}

export async function killPrevService (ns, serviceName, writeback=true) {
  const contents = ns.read('services.txt')
  if (contents === '') {
    return []
  }
  try {
    const services = JSON.parse(contents)
    const serviceIndex = services.findIndex(s => s.name === serviceName)
    if (serviceIndex === -1) {
      return services
    }
    // remove from service array, kill interval, write back
    const intervalId = services.splice(serviceIndex, 1)[0].intervalId
    _win.clearInterval(intervalId)
    log(ns, `Killed previous interval with id ${intervalId}`)
    if (writeback) {
      await ns.write('services.txt', JSON.stringify(services, null, 2), 'w')
    }
    return services
  }
  catch (err) {
    if (err instanceof SyntaxError) {
      log(ns, `WARNING: service listing for ${serviceName} is invalid: ${contents}`)
    }
    else throw err
  }
}

export async function registerService (ns, serviceName, intervalId) {
  // kill previous service with this name, if any
  const services = await killPrevService(ns, serviceName, false)
  const newService = { name: serviceName, started: Date.now(), intervalId: intervalId }
  services.push(newService)
  // write info to services file
  await ns.write('services.txt', JSON.stringify(services, null, 2), 'w')
  log(ns, `Registered new service ${serviceName} with id ${intervalId}`)
}

export async function main (ns) {
  ns.disableLog('ALL')
  const options = ns.flags(argsSchema)
  if (options['kill']) {
    await killPrevService(ns, serviceName)
    return
  }
  const service = await new InfiltrationService(ns)
  await sleep(2000)
  if (!service.automationEnabled) {
    // fail silently if the backend wasn't found
    log(ns, 'Could not establish websocket connection. Exiting infiltration service.')
    log(ns, 'The file you need to run locally can be found here: https://pastebin.com/psmzQDEZ')
    log(ns, 'Download as `echo-server.py` and run with Python 3.7 or above: `python echo-server.py`.')
    return
  }
  const intervalId = service.start()
  await registerService(ns, serviceName, intervalId)
  log(ns, `Started infiltration service`, false, 'info')
  log(ns, `Service is running with interval ID ${intervalId}. Script will now exit.`)
}
