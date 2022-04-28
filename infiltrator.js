/* infiltrator.js
 * Fully-automated infiltrator
 * This file uses a service paradigm, or a zero-RAM task running almost-invisibly via setInterval.
 * Information on running services is stored in the local file `services.txt`.
 * Running this file will launch the service (killing any previous instances), store its info, and quickly exit.
 * TODO: Add support for cycling infiltrations automatically
 * TODO: add support for time-stretched human assistance mode, maybe
 * TODO: separate out services logic into a `services.js` so more can be easily added (e.g. terminal monitor)
 */

import { log, formatMoney, formatNumberShort, tryGetBitNodeMultipliers, getNsDataThroughFile } from './helpers.js'

// delays for setTimeout and setInterval above this threshold are not modified
// (helps prevent issues with hacking scripts)
const maxDelayCutoff = 30e3

let infiltrationTimeFactor, keyDelay

// interval to check for infiltration/game updates
const tickInterval = 50

// unique name to prevent overlaps
const serviceName = 'infiltrator'


let _win = [].map.constructor('return this')()
let _doc = [].map.constructor('return this.document')()

const argsSchema = [
  ['kill', false],     // set to stop the old service and not start a new one
  ['timeFactor', 0.5], // interval multiplier to apply during infiltrations (set to 1 to disable)
  ['keyDelay', 1]      // delay in ms between keystrokes
]

export function autocomplete(data) {
  data.flags(argsSchema)
  return []
}

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
  .rewardTooltip {
    color: #0d0;
    font-family: Consolas;
    margin: auto;
  }
  </style>`
  _doc.getElementById('infilCss')?.remove()
  _doc.head.insertAdjacentHTML('beforeend', css);
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
      return _win._setTimeout(fn, Math.round(delay * factor), ...args)
    } else {
      return _win._setTimeout(fn, delay, ...args)
    }
  }
  _win.setInterval = function (fn, delay, ...args) {
    if (delay < maxDelayCutoff) {
      return _win._setInterval(fn, Math.round(delay * factor), ...args)
    } else {
      return _win._setInterval(fn, delay, ...args)
    }
  }
  lastFactor = factor
  return true
}

function autoSetTimeFactor () {
  const lvlReg = /^Level:\s+\d+\s*\/\s*\d+$/
  const levelElement = queryFilter('p', lvlReg)

  if (levelElement === undefined) {
    if (setTimeFactor(1)) {
      logConsole('Infiltration not detected: removing injection')
    }
  } else {
    if (setTimeFactor(infiltrationTimeFactor)) {
      logConsole('Infiltration detected: injecting middleware')
    }
  }
}

// event listener stuff, stolen from https://github.com/stracker-phil/bitburner/blob/main/daemon/infiltrate.js

function pressKey (key) {
  let keyCode = key.charCodeAt(0);

  const keyboardEvent = new KeyboardEvent('keydown', {
    key,
    keyCode,
  });

  _doc.dispatchEvent(keyboardEvent);
}

/**
 * Wrap all event listeners with a custom function that injects
 * the "isTrusted" flag.
 *
 * Is this cheating? Or is it real hacking? Don't care, as long
 * as it's working :)
 */
function wrapEventListeners () {
  if (!_doc._addEventListener) {
    _doc._addEventListener = _doc.addEventListener;

    _doc.addEventListener = function (type, callback, options) {
      if ("undefined" === typeof options) {
        options = false;
      }
      let handler = false;

      // For this script, we only want to modify "keydown" events.
      if ("keydown" === type) {
        handler = function (...args) {
          if (!args[0].isTrusted) {
            const hackedEv = {};

            for (const key in args[0]) {
              if ("isTrusted" === key) {
                hackedEv.isTrusted = true;
              } else if ("function" === typeof args[0][key]) {
                hackedEv[key] = args[0][key].bind(args[0]);
              } else {
                hackedEv[key] = args[0][key];
              }
            }

            args[0] = hackedEv;
          }

          return callback.apply(callback, args);
        };

        for (const prop in callback) {
          if ("function" === typeof callback[prop]) {
            handler[prop] = callback[prop].bind(callback);
          } else {
            handler[prop] = callback[prop];
          }
        }
      }

      if (!this.eventListeners) {
        this.eventListeners = {};
      }
      if (!this.eventListeners[type]) {
        this.eventListeners[type] = [];
      }
      this.eventListeners[type].push({
        listener: callback,
        useCapture: options,
        wrapped: handler,
      });

      return this._addEventListener(
        type,
        handler ? handler : callback,
        options
      );
    };
  }

  if (!_doc._removeEventListener) {
    _doc._removeEventListener = _doc.removeEventListener;

    _doc.removeEventListener = function (type, callback, options) {
      if ("undefined" === typeof options) {
        options = false;
      }

      if (!this.eventListeners) {
        this.eventListeners = {};
      }
      if (!this.eventListeners[type]) {
        this.eventListeners[type] = [];
      }

      for (let i = 0; i < this.eventListeners[type].length; i++) {
        if (
          this.eventListeners[type][i].listener === callback &&
          this.eventListeners[type][i].useCapture === options
        ) {
          if (this.eventListeners[type][i].wrapped) {
            callback = this.eventListeners[type][i].wrapped;
          }

          this.eventListeners[type].splice(i, 1);
          break;
        }
      }

      if (this.eventListeners[type].length == 0) {
        delete this.eventListeners[type];
      }

      return this._removeEventListener(type, callback, options);
    };
  }
}

/**
 * Revert the "wrapEventListeners" changes.
 */
function unwrapEventListeners () {
  if (_doc._addEventListener) {
    _doc.addEventListener = _doc._addEventListener;
    delete _doc._addEventListener;
  }
  if (_doc._removeEventListener) {
    _doc.removeEventListener = _doc._removeEventListener;
    delete _doc._removeEventListener;
  }
  delete _doc.eventListeners;
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

function pressStart () {
  const infiltrating = [..._doc.getElementsByTagName('h4')].find(e => e.innerText.includes('Infiltrating')) !== undefined
  if (!infiltrating) return
  [..._doc.getElementsByTagName('button')].find(e => e.innerText.includes('Start'))?.click()
}

function queryFilter (query, filter) {
  return [..._doc.querySelectorAll(query)].find(e => e.innerText.trim().match(filter))
}

class InfiltrationService {
  constructor (ns, rewardInfo = []) {
    const self = this
    addCss()
    wrapEventListeners()
    self.rewardInfo = rewardInfo
    self.tickComplete = true
    self.automationEnabled = true // leaving this in to support a possible future human-assist mode with no keypresses
  }

  async sendKeyString (str) {
    const self = this
    // self.ws.send(str)
    for (let c of str) {
      pressKey(c)
      await sleep(keyDelay)
    }
  }

  infilButtonUpdate () {
    const self = this
    const buttonNode = queryFilter('button', 'Infiltrate Company')
    if (buttonNode === undefined) {
      return
    }
    buttonNode.classList.add('infiltrationEnabled')
    // if we've already added a tooltip, return
    if (_doc.getElementsByClassName('rewardTooltip')[0]) return
    // get the name of the company we're at
    // check tooltip first, in case we've backdoored and text is wonky
    const titleSpan = buttonNode.parentNode.parentNode.firstChild.nextSibling
    const companyName = titleSpan.ariaLabel ? titleSpan.ariaLabel.slice(22,-1) : titleSpan.textContent
    var info = self.rewardInfo.find(c => c.name === companyName)
    const rewardStr = `${formatMoney(info.moneyGain)}, ${formatNumberShort(info.repGain)} rep (${info.maxClearanceLevel})`
    buttonNode.insertAdjacentHTML('afterend', `<span class='rewardTooltip'>${rewardStr}</span>`)
  }

  markSolution () {
    // TODO
  }

  clearSolution() {
    // TODO
  }

  async cyberpunk () {
    let targetElement = queryFilter('h5', 'Targets:')
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
    await this.sendKeyString(pathStr)
    while (targetElement !== undefined) {
      await sleep(50)
      targetElement = queryFilter('h5', 'Targets:')
    }
  }
  async mines () {
    const memoryPhaseText = 'Remember all the mines!'
    const markPhaseText = 'Mark all the mines!'

    if (!queryFilter('h4', memoryPhaseText)) return
    logConsole('Game active: Minesweeper game')
    const gridElements = [..._doc.querySelectorAll('span')].filter(el => el.innerText.trim().match(/^\[[X.\s?]\]$/))
    if (gridElements.length === 0) return
    // get size
    const sizeX = gridElements[0].parentNode.childElementCount
    const sizeY = gridElements[0].parentNode.parentNode.parentNode.childElementCount
    // get coordinates for each mine
    const mineCoords = gridElements.filter(el => el.innerText.trim().match(/^\[\?\]$/)).map(el => [getGridX(el), getGridY(el)])
    // wait for mark phase
    while (queryFilter('h4', memoryPhaseText)) {
      await sleep(50)
    }
    // send solution string
    const pathStr = getPathSequential(sizeX, sizeY, mineCoords).join(' ') + ' '
    logConsole(`Mine solution string: ${pathStr}`)
    await this.sendKeyString(pathStr)
    // wait for end
    while (queryFilter('h4', markPhaseText)) {
      await sleep(50)
    }
  }

  async slash () {
    const self = this
    if (!self.automationEnabled) return
    const activeText = 'Slash when his guard is down!'
    let activeElement = queryFilter('h4', activeText)
    while (activeElement !== undefined) {
      logConsole('Game active: Slash game')
      if (queryFilter('h4','ATTACKING!')) {
        await sleep(1)
        await self.sendKeyString(' ')
      }
      await sleep(1)
      activeElement = queryFilter('h4', activeText)
    }
  }

  async brackets () {
    const self = this
    if (!self.automationEnabled) return
    const activeText = 'Close the brackets'
    let activeElement = queryFilter('h4', activeText)
    if (activeElement === undefined) return
    logConsole('Game active: Bracket game')
    const bracketText = activeElement.nextSibling.innerText
    const closeText = bracketText.split('').reverse().join('')
      .replaceAll('<', '>')
      .replaceAll('(', ')')
      .replaceAll('[', ']')
      .replaceAll('{', '}')
    await self.sendKeyString(closeText)
    while (activeElement !== undefined) {
      activeElement = queryFilter('h4', activeText)
      await sleep(50)
    }
  }

  async cheatCode () {
    const self = this
    if (!self.automationEnabled) return
    const arrowsMap = { '↑': 'w', '→': 'd', '↓': 's', '←': 'a' }
    const activeText = 'Enter the Code!'
    let activeElement = queryFilter('h4', activeText)
    let lastArrow
    while (activeElement !== undefined) {
      logConsole('Game active: Cheat Code game')
      const arrow = activeElement?.nextSibling?.innerText
      if (arrow !== lastArrow) {
        if (arrow in arrowsMap) {
          await self.sendKeyString(arrowsMap[arrow])
          // logConsole(`Sent '${arrowsMap[arrow]}'`)
          lastArrow = arrow
        } else {
          return
        }
      }
      activeElement = queryFilter('h4', activeText)
      await sleep(10)
    }
  }

  async backwardGame () {
    const self = this
    if (!self.automationEnabled) return
    const activeText = 'Type it'
    let activeElement = queryFilter('h4', activeText)
    if (activeElement === undefined) return
    logConsole('Game active: Backward game')
    const text = activeElement.parentNode.nextSibling.children[0].innerText
    await self.sendKeyString(text.toLowerCase())
    while (activeElement !== undefined) {
      activeElement = queryFilter('h4', activeText)
      await sleep(50)
    }
  }

  async bribeGame () {
    const self = this
    if (!self.automationEnabled) return
    const activeText = 'Say something nice about the guard.'
    let activeElement = queryFilter('h4', activeText)
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
        await self.sendKeyString(' ')
      } else if (lastWord !== currentWord) {
        await self.sendKeyString('w')
        lastWord = currentWord
      }
      activeElement = queryFilter('h4', activeText)
      await sleep(5)
    }
  }

  async wireCuttingGame () {
    const self = this
    if (!self.automationEnabled) return
    const activeText = 'Cut the wires'
    const activeElement = queryFilter('h4', activeText)
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
    await this.sendKeyString(solutionStr)
    // wait for end
    while (queryFilter('h4', activeText) !== undefined) {
      await sleep(50)
    }
  }

  async tick () {
    const self = this
    // prevent overlapping execution
    if (!self.tickComplete) return
    self.tickComplete = false
    // Add visual indicator to infiltration screen
    self.infilButtonUpdate()
    // Press start if it's visible
    pressStart()
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

// calculation stuff

const locationInfo = [{
  name: 'AeroCorp',
  maxClearanceLevel: 12,
  startingSecurityLevel: 8.18
}, {
  name: 'Bachman & Associates',
  maxClearanceLevel: 15,
  startingSecurityLevel: 8.19
}, {
  name: 'Clarke Incorporated',
  maxClearanceLevel: 18,
  startingSecurityLevel: 9.55
}, {
  name: 'ECorp',
  maxClearanceLevel: 37,
  startingSecurityLevel: 17.02
}, {
  name: 'Fulcrum Technologies',
  maxClearanceLevel: 25,
  startingSecurityLevel: 15.54
}, {
  name: 'Galactic Cybersystems',
  maxClearanceLevel: 12,
  startingSecurityLevel: 7.89
}, {
  name: 'NetLink Technologies',
  maxClearanceLevel: 6,
  startingSecurityLevel: 3.29
}, {
  name: 'Aevum Police Headquarters',
  maxClearanceLevel: 6,
  startingSecurityLevel: 5.35
}, {
  name: 'Rho Construction',
  maxClearanceLevel: 5,
  startingSecurityLevel: 5.02
}, {
  name: 'Watchdog Security',
  maxClearanceLevel: 7,
  startingSecurityLevel: 5.85
}, {
  name: 'KuaiGong International',
  maxClearanceLevel: 25,
  startingSecurityLevel: 16.25
}, {
  name: 'Solaris Space Systems',
  maxClearanceLevel: 18,
  startingSecurityLevel: 12.59
}, {
  name: 'Nova Medical',
  maxClearanceLevel: 12,
  startingSecurityLevel: 5.02
}, {
  name: 'Omega Software',
  maxClearanceLevel: 10,
  startingSecurityLevel: 3.2
}, {
  name: 'Storm Technologies',
  maxClearanceLevel: 25,
  startingSecurityLevel: 5.38
}, {
  name: 'DefComm',
  maxClearanceLevel: 17,
  startingSecurityLevel: 7.18
}, {
  name: 'Global Pharmaceuticals',
  maxClearanceLevel: 20,
  startingSecurityLevel: 5.9
}, {
  name: 'Noodle Bar',
  maxClearanceLevel: 5,
  startingSecurityLevel: 2.5
}, {
  name: 'VitaLife',
  maxClearanceLevel: 25,
  startingSecurityLevel: 5.52
}, {
  name: 'Alpha Enterprises',
  maxClearanceLevel: 10,
  startingSecurityLevel: 3.62
}, {
  name: 'Blade Industries',
  maxClearanceLevel: 25,
  startingSecurityLevel: 10.59
}, {
  name: 'Carmichael Security',
  maxClearanceLevel: 15,
  startingSecurityLevel: 4.66
}, {
  name: 'DeltaOne',
  maxClearanceLevel: 12,
  startingSecurityLevel: 5.9
}, {
  name: 'Four Sigma',
  maxClearanceLevel: 25,
  startingSecurityLevel: 8.18
}, {
  name: 'Icarus Microsystems',
  maxClearanceLevel: 17,
  startingSecurityLevel: 6.02
}, {
  name: 'Joe\'s Guns',
  maxClearanceLevel: 5,
  startingSecurityLevel: 3.13
}, {
  name: 'MegaCorp',
  maxClearanceLevel: 31,
  startingSecurityLevel: 16.36
}, {
  name: 'Universal Energy',
  maxClearanceLevel: 12,
  startingSecurityLevel: 5.9
}, {
  name: 'CompuTek',
  maxClearanceLevel: 15,
  startingSecurityLevel: 3.59
}, {
  name: 'Helios Labs',
  maxClearanceLevel: 18,
  startingSecurityLevel: 7.28
}, {
  name: 'LexoCorp',
  maxClearanceLevel: 15,
  startingSecurityLevel: 4.35
}, {
  name: 'NWO',
  maxClearanceLevel: 50,
  startingSecurityLevel: 8.53
}, {
  name: 'OmniTek Incorporated',
  maxClearanceLevel: 25,
  startingSecurityLevel: 7.74
}, {
  name: 'Omnia Cybersystems',
  maxClearanceLevel: 22,
  startingSecurityLevel: 6
}, {
  name: 'SysCore Securities',
  maxClearanceLevel: 18,
  startingSecurityLevel: 4.77
}]

export function calculateSkill (exp, mult = 1) {
  return Math.max(Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)), 1)
}

function calcReward (player, startingDifficulty) {
  const xpMult = 10 * 60 * 15
  const stats =
    calculateSkill((player?.strength_exp_mult ?? 1) * xpMult, (player?.strength_mult ?? 1)) +
    calculateSkill((player?.defense_exp_mult ?? 1) * xpMult, (player?.defense_mult ?? 1)) +
    calculateSkill((player?.agility_exp_mult ?? 1) * xpMult, (player?.agility_mult ?? 1)) +
    calculateSkill((player?.dexterity_exp_mult ?? 1) * xpMult, (player?.dexterity_mult ?? 1)) +
    calculateSkill((player?.charisma_exp_mult ?? 1) * xpMult, (player?.charisma_mult ?? 1))
  let difficulty = startingDifficulty - Math.pow(stats, 0.9) / 250 - player.intelligence / 1600
  if (difficulty < 0) difficulty = 0
  if (difficulty > 3) difficulty = 3
  return difficulty
}

function getAllRewards (ns, bnMults, player, display=false) {
  const locations = [...locationInfo]
  for (const location of locations) {
    const levelBonus = location.maxClearanceLevel * Math.pow(1.01, location.maxClearanceLevel)
    const reward = calcReward(player, location.startingSecurityLevel)
    location.repGain =
      Math.pow(reward + 1, 1.1) *
      Math.pow(location.startingSecurityLevel, 1.2) *
      30 *
      levelBonus *
      (bnMults?.InfiltrationRep ?? 1)
    location.moneyGain =
      Math.pow(reward + 1, 2) *
      Math.pow(location.startingSecurityLevel, 3) *
      3e3 *
      levelBonus *
      (bnMults?.InfiltrationMoney ?? 1)
    location.repScore = location.repGain / location.maxClearanceLevel
    location.moneyScore = location.moneyGain / location.maxClearanceLevel
  }
  // sort and display
  locations.sort((a, b) => a.repScore - b.repScore)
  if (display) {
    for (const location of locations) {
      log(ns, location.name, true)
      log(ns, `  ${Math.round(location.repGain)} rep, ${formatMoney(location.moneyGain)}, ${location.maxClearanceLevel} levels`, true)
      log(ns, `  ${formatMoney(location.moneyScore.toPrecision(4))} / lvl`, true)
      log(ns, `  ${(location.repScore.toPrecision(4))} rep / lvl`, true)
    }
  }
  return locations
}

// service stuff

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
    log(ns, `Killed previous interval with id ${intervalId}`, false, 'info')
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
    setTimeFactor(1)
    await killPrevService(ns, serviceName)
    return
  }
  infiltrationTimeFactor = options['timeFactor']
  keyDelay = options['keyDelay']
  // get BN multipliers first to feed reward info to infiltration service
  const bnMults = await tryGetBitNodeMultipliers(ns)
  const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')
  const locations = getAllRewards(ns, bnMults, player)
  // launch service and see if it connects
  const service = new InfiltrationService(ns, locations)
  const intervalId = service.start()
  await registerService(ns, serviceName, intervalId)
  log(ns, `Started infiltration service`, false, 'success')
  log(ns, `Service is running with interval ID ${intervalId}. Script will now exit.`)
}
