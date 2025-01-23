//file based on source from https://pastebin.com/bLuWWQzT , updated for Bitburner v2.6.1
// fixes: "say something nice to the guard", "attack guard", "enter the code", auto select reputation for faction
// work in progress: auto heal in hospital


//important parameters: "--auto" for auto replay, "--faction BitRunners" for auto-accepting reputation for named faction

const state = {
  // Name of the company that's infiltrated.
  company: "",

  // A copy of company, used for auto-restart so it doesn't get reset at end
  lastCompany: "",

  // Whether infiltration started. False means, we're
  // waiting to arrive on the infiltration screen.
  started: false,

  // Details/state of the current mini game.
  // Is reset after every game.
  game: {},
};

// automatically accept reward and re-run for the same company
let auto = false


// auto-accept reputation for faction instead of money
let repFaction = ''


// Speed of game actions, in milliseconds.
const speed = 22;

// Time infiltration(s)
let infiltrationStart = 0

// Small hack to save RAM.
// This will work smoothly, because the script does not use
// any "ns" functions, it's a pure browser automation tool.
const wnd = eval("window");
const doc = wnd["document"];

// List of all games and an automated solver.
const infiltrationGames = [
  {
    name: "type it backward",
    init: function (screen) {
      const lines = getLines(getEl(screen, "p"));
      state.game.data = lines[0].split("");
    },
    play: function (screen) {
      if (!state.game.data || !state.game.data.length) {
        delete state.game.data;
        return;
      }

      pressKey(state.game.data.shift());
    },
  },
  {
    name: "enter the code",
    init: function (screen) { },
    play: function (screen) {
      const h4 = getEl(screen, "h4");
	  // console.log("enter the code: h4 ", h4);
	  // console.log("enter the code: h4[1] ", h4[1]);
      const code = h4[1].textContent;
	  const code2 = code.replaceAll("?","").slice(-1);
		
	
      switch (code2) {
        case "↑":
          pressKey("w");
          break;
        case "↓":
          pressKey("s");
          break;
        case "←":
          pressKey("a");
          break;
        case "→":
          pressKey("d");
          break;
      }
    },
  },
  {
    name: "close the brackets",
    init: function (screen) {
      const data = getLines(getEl(screen, "p"));
      const brackets = data.join("").split("");
      state.game.data = [];

      for (let i = brackets.length - 1; i >= 0; i--) {
        const char = brackets[i];

        if ("<" == char) {
          state.game.data.push(">");
        } else if ("(" == char) {
          state.game.data.push(")");
        } else if ("{" == char) {
          state.game.data.push("}");
        } else if ("[" == char) {
          state.game.data.push("]");
        }
      }
    },
    play: function (screen) {
      if (!state.game.data || !state.game.data.length) {
        delete state.game.data;
        return;
      }

      pressKey(state.game.data.shift());
    },
  },

  {
    name: "attack after the guard drops his guard and is distracted",
    init: function (screen) {
      state.game.data = "wait";
    },
    play: function (screen) {
      const data = getLines(getEl(screen, "h4"));
      if ("attack" === state.game.data) {
        pressKey(" ");
        state.game.data = "done";
      }
      // Attack in next frame - instant attack sometimes ends in failure.		
      if ('wait' === state.game.data && -1 !== data.indexOf('Distracted!')) {
        state.game.data = "attack";
      }
    },
  },

   {   
    name: "attack when his guard is down",        
        init: function (screen) {            
            state.game.data = "wait";
        },
        play: function (screen) {
            const data = getLines(getEl(screen, "h4"));
             if ("attack" === state.game.data) {
                pressKey(" ");
                state.game.data = "done";
            }
             // Attack in next frame - instant attack sometimes
            // ends in failure.
            if ('wait' === state.game.data && -1 !== data.indexOf("Preparing?")) {
                state.game.data = "attack";
            }
        },
  },
  {
    name: "say something nice about the guard",
    init: function (screen) { },
    play: function (screen) {
      const correct = [
        "affectionate",
        "agreeable",
        "bright",
        "charming",
        "creative",
        "determined",
        "energetic",
        "friendly",
        "funny",
        "generous",
        "polite",
        "likable",
        "diplomatic",
        "helpful",
        "giving",
        "kind",
        "hardworking",
        "patient",
        "dynamic",
        "loyal",
        "straightforward",
      ];
      const word = getLines(getEl(screen, "h5"))[1];

      if (-1 !== correct.indexOf(word)) {
        pressKey(" ");
      } else {
        pressKey("w");
      }
    },
  },
  {
    name: "remember all the mines",
    init: function (screen) {
      const rows = getEl(screen, "p");
      let gridSize = null;
      switch (rows.length) {
        case 9:
          gridSize = [3, 3];
          break;
        case 12:
          gridSize = [3, 4];
          break;
        case 16:
          gridSize = [4, 4];
          break;
        case 20:
          gridSize = [4, 5];
          break;
        case 25:
          gridSize = [5, 5];
          break;
        case 30:
          gridSize = [5, 6];
          break;
        case 36:
          gridSize = [6, 6];
          break;
      }
      if (gridSize == null) {
        return;
      }
      //12 20 30 42
      state.game.data = [];
      let index = 0;
      //for each row
      for (let y = 0; y < gridSize[1]; y++) {
        //initialize array data
        state.game.data[y] = [];
        for (let x = 0; x < gridSize[0]; x++) {
          //for each column in the row add to state data if it has a child
          if (rows[index].children.length > 0) {
            state.game.data[y].push(true);
          } else state.game.data[y].push(false);
          index += 1;
        }
      }
    },
    play: function (screen) { },
  },
  {
    name: "mark all the mines",
    init: function (screen) {
      state.game.x = 0;
      state.game.y = 0;
      state.game.cols = state.game.data[0].length;
      state.game.dir = 1;
    },
    play: function (screen) {
      let { data, x, y, cols, dir } = state.game;

      if (data[y][x]) {
        pressKey(" ");
        data[y][x] = false;
      }

      x += dir;

      if (x < 0 || x >= cols) {
        x = Math.max(0, Math.min(cols - 1, x));
        y++;
        dir *= -1;
        pressKey("s");
      } else {
        pressKey(dir > 0 ? "d" : "a");
      }

      state.game.data = data;
      state.game.x = x;
      state.game.y = y;
      state.game.dir = dir;
    },
  },
  {
    name: "match the symbols",
    init: function (screen) {
      const data = getLines(getEl(screen, "h5 span"));
      const rows = getLines(getEl(screen, "p"));
      const keypad = [];
      const targets = [];
      let gridSize = null;
      switch (rows.length) {
        case 9:
          gridSize = [3, 3];
          break;
        case 12:
          gridSize = [3, 4];
          break;
        case 16:
          gridSize = [4, 4];
          break;
        case 20:
          gridSize = [4, 5];
          break;
        case 25:
          gridSize = [5, 5];
          break;
        case 30:
          gridSize = [5, 6];
          break;
        case 36:
          gridSize = [6, 6];
          break;
      }
      if (gridSize == null) {
        return;
      }
      //build the keypad grid.
      let index = 0;
      for (let i = 0; i < gridSize[1]; i++) {
        keypad[i] = [];
        for (let y = 0; y < gridSize[0]; y++) {

          keypad[i].push(rows[index]);
          index += 1;
        }
      }
      //foreach data get coords of keypad entry
      for (let i = 0; i < data.length; i++) {
        const symbol = data[i].trim();
        //for each keypad entry
        for (let j = 0; j < keypad.length; j++) {
          const k = keypad[j].indexOf(symbol);

          if (-1 !== k) {
            targets.push([j, k]);
            break;
          }
        }
      }
      state.game.data = targets;
      state.game.x = 0;
      state.game.y = 0;
    },
    play: function (screen) {
      const target = state.game.data[0];
      let { x, y } = state.game;

      if (!target) {
        return;
      }

      const to_y = target[0];
      const to_x = target[1];

      if (to_y < y) {
        y--;
        pressKey("w");
      } else if (to_y > y) {
        y++;
        pressKey("s");
      } else if (to_x < x) {
        x--;
        pressKey("a");
      } else if (to_x > x) {
        x++;
        pressKey("d");
      } else {
        pressKey(" ");
        state.game.data.shift();
      }

      state.game.x = x;
      state.game.y = y;
    },
  },
  {
    name: "cut the wires with the following properties",
    init: function (screen) {
      let numberHack = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
      const colors = {
        red: "red",
        white: "white",
        blue: "blue",
        "rgb(255, 193, 7)": "yellow",
      };
      const wireColor = {
        red: [],
        white: [],
        blue: [],
        yellow: [],
      };
      //gather the instructions
      var instructions = []
      for (let child of screen.children) instructions.push(child);
      var wiresData = instructions.pop();
      instructions.shift();
      instructions = getLines(instructions);
      //get the wire information
      const samples = getEl(wiresData, "p");
      const wires = [];
      //get the amount of wires
      let wireCount = 0;
      for (let i = wireCount; i < samples.length; i++) {
        if (numberHack.includes(samples[i].innerText)) wireCount += 1;
        else break;
      }
      let index = 0;
      //get just the first 3 rows of wires.
      for (let i = 0; i < 3; i++) {
        //for each row
        for (let j = 0; j < wireCount; j++) {
          const node = samples[index];
          const color = colors[node.style.color];
          if (!color) {
            index += 1;
            continue;
          }
          wireColor[color].push(j + 1);
          index += 1;
        }
      }

      for (let i = 0; i < instructions.length; i++) {
        const line = instructions[i].trim().toLowerCase();

        if (!line || line.length < 10) {
          continue;
        }
        if (-1 !== line.indexOf("cut wires number")) {
          const parts = line.split(/(number\s*|\.)/);
          wires.push(parseInt(parts[2]));
        }
        if (-1 !== line.indexOf("cut all wires colored")) {
          const parts = line.split(/(colored\s*|\.)/);
          const color = parts[2];

          if (!wireColor[color]) {
            // should never happen.
            continue;
          }

          wireColor[color].forEach((num) => wires.push(num));
        }
      }

      // new Set() removes duplicate elements.
      state.game.data = [...new Set(wires)];
    },
    play: function (screen) {
      const wire = state.game.data;
      //state.game.data.shift();
      if (!wire) {
        return;
      }
      for (let i = 0; i < wire.length; i++) {
        pressKey(wire[i].toString());
      }
    },
  },
];

/** @param {NS} ns **/
export async function main(ns) {
  const args = ns.flags([
    ["start", false],
    ["stop", false],
    ["status", false],
    ["quiet", false],
    ["auto", false],
    ["faction", ''],
  ]);

  auto = args.auto

  repFaction = args.faction && args.faction && args.faction.length && args.faction

  function print(msg) {
    if (!args.quiet) {
      ns.tprint(`\n${msg}\n`);
    }
  }

  if (args.status) {
    if (wnd.tmrAutoInf) {
      print("Automated infiltration is active");
    } else {
      print("Automated infiltration is inactive");
    }
    return;
  }

  if (wnd.tmrAutoInf) {
    print("Stopping automated infiltration...");
    clearInterval(wnd.tmrAutoInf);
    delete wnd.tmrAutoInf;
  }

  if (args.stop) {
    return;
  }

  auto = args.auto

  repFaction = args.faction && args.faction && args.faction.length && args.faction

  print(
    "Automated infiltration is enabled...\nWhen you visit the infiltration screen of any company, all tasks are completed automatically.\n" +
    `Auto? ${auto}\n` +
    `Faction or Money? ${repFaction || 'MONEY'}`
  );

  endInfiltration();

  // Monitor the current screen and start infiltration once a
  // valid screen is detected.
  wnd.tmrAutoInf = setInterval(infLoop, speed);

  // Modify the addEventListener logic.
  wrapEventListeners();
}

/**
 * The infiltration loop, which is called at a rapid interval
 */
function infLoop() {
  if (!state.started) {
    waitForStart();
  } else {
    playGame();
  }
}

/**
 * Returns a list of DOM elements from the main game
 * container.
 */
function getEl(parent, selector) {
  let prefix = ":scope";

  if ("string" === typeof parent) {
    selector = parent;
    parent = doc;

    prefix = ".MuiBox-root>.MuiBox-root>.MuiBox-root";

    if (!doc.querySelectorAll(prefix).length) {
      prefix = ".MuiBox-root>.MuiBox-root>.MuiGrid-root";
    }
    if (!doc.querySelectorAll(prefix).length) {
      prefix = ".MuiContainer-root>.MuiPaper-root";
    }
    if (!doc.querySelectorAll(prefix).length) {
      return [];
    }
  }

  selector = selector.split(",");
  selector = selector.map((item) => `${prefix} ${item}`);
  selector = selector.join(",");

  return parent.querySelectorAll(selector);
}

/**
 * Returns the first element with matching text content.
 */
function filterByText(elements, text) {
  text = text.toLowerCase();

  for (let i = 0; i < elements.length; i++) {
    const content = elements[i].textContent.toLowerCase();

    if (-1 !== content.indexOf(text)) {
      return elements[i];
    }
  }

  return null;
}

/**
 * Returns an array with the text-contents of the given elements.
 *
 * @param {NodeList} elements
 * @returns {string[]}
 */
function getLines(elements) {
  const lines = [];
  elements.forEach((el) => lines.push(el.textContent));

  return lines;
}

let postTimeout = null

/**
 * Reset the state after infiltration is done.
 */
function endInfiltration() {
  unwrapEventListeners();
  state.company = "";
  state.started = false;
  // cancelMyTimeout()
  // acceptMoney() // TODO: needed?
}

/**
 * Simulate a keyboard event (keydown + keyup).
 *
 * @param {string|int} keyOrCode A single letter (string) or key-code to send.
 */
function pressKey(keyOrCode) {
  let keyCode = 0;
  let key = "";

  if ("string" === typeof keyOrCode && keyOrCode.length > 0) {
    key = keyOrCode.toLowerCase().substr(0, 1);
    keyCode = key.charCodeAt(0);
  } else if ("number" === typeof keyOrCode) {
    keyCode = keyOrCode;
    key = String.fromCharCode(keyCode);
  }

  if (!keyCode || key.length !== 1) {
    return;
  }

  function sendEvent(event) {
    const keyboardEvent = new KeyboardEvent(event, {
      key,
      keyCode,
    });

    doc.dispatchEvent(keyboardEvent);
  }

  sendEvent("keydown")
}

/**
 * Infiltration monitor to start automatic infiltration.
 *
 * This function runs asynchronously, after the "main" function ended,
 * so we cannot use any "ns" function here!
 */
function waitForStart() {
  if (state.started) {
    return;
  }

  const h4 = getEl("h4");

  if (!h4.length) {
    return;
  }
  const title = h4[0].textContent;
  if (0 !== title.indexOf("Infiltrating")) {
    return;
  }

  const btnStart = filterByText(getEl("button"), "Start");
  if (!btnStart) {
    return;
  }

  state.company = title.substr(13);
  state.lastCompany = title.substr(13);
  state.started = true;
  wrapEventListeners();

var datetime = new Date().today() + " @ " + new Date().timeNow();
  console.log(datetime, " Start automatic infiltration of", state.company);
  btnStart.click();
}

/**
 * Identify the current infiltration game.
 */
function playGame() {
  const screens = doc.querySelectorAll(".MuiContainer-root");
  wnd.info = { screens }

  if (!screens.length) {
    wnd.info = { screens, messge: 'no screens.length, calling endInfiltration()' }
    endInfiltration();
	//refillhealth();
    selectCompany();
    return;
  }
  if (screens[0].children.length < 3) {
    wnd.info = { screens, message: 'screens.children.length < 3, calling endInfiltration()' }
    if (!postTimeout && screens[0].children[1].children[0].innerText === 'Infiltration successful!') {
      acceptMoney('spam') // I think this is spamming, yes, need to check for infiltration complete, but where
    }
    return;
  }

  const screen = screens[0].children[2];
  const h4 = getEl(screen, "h4");

  if (!h4.length) {
    wnd.info = { screens, message: 'no h4.length, calling endInfiltration()' }
    endInfiltration();
    return;
  }

  cancelMyTimeout()

  const title = h4[0].textContent.trim().toLowerCase().split(/[!.(]/)[0];
  wnd.info = { screens, message: 'searching for something', title }

  if ("infiltration successful" === title) {
    // NOTE: I get screens.length < 3 on success, not this...
    wnd.info = { screens, message: 'infiltration successful!' }
    endInfiltration();
    return;
  } else {
    wnd.last_title = title
  }

  if ("get ready" === title) {
    if (!infiltrationStart) infiltrationStart = new Date().valueOf()
    return;
  }

  const game = infiltrationGames.find((game) => game.name === title);
  wnd.STATE = { game, screen, h4, title }

  if (game) {
    if (!infiltrationStart) infiltrationStart = new Date().valueOf()
    if (state.game.current !== title) {
      state.game.current = title;
      game.init(screen);
      game.waitFrames = Math.max(game.waitFrames || 0, 15)
    } else {
      if (game.waitFrames > 0) {
        game.waitFrames--
      } else {
        game.play(screen);
      }
    }

  } else {
    console.error("Unknown game:", title);
  }
}

/**
 * Wrap all event listeners with a custom function that injects
 * the "isTrusted" flag.
 *
 * Is this cheating? Or is it real hacking? Don't care, as long
 * as it's working :)
 */
function wrapEventListeners() {
  if (!doc._addEventListener) {
    doc._addEventListener = doc.addEventListener;

    doc.addEventListener = function (type, callback, options) {
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

  if (!doc._removeEventListener) {
    doc._removeEventListener = doc.removeEventListener;

    doc.removeEventListener = function (type, callback, options) {
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
function unwrapEventListeners() {
  if (doc._addEventListener) {
    doc.addEventListener = doc._addEventListener;
    delete doc._addEventListener;
  }
  if (doc._removeEventListener) {
    doc.removeEventListener = doc._removeEventListener;
    delete doc._removeEventListener;
  }
  delete doc.eventListeners;
}



/*================================================================================
  = Auto Mode
  ================================================================================*/

/**
 * Select a company and begin infiltration for auto mode
 */
function selectCompany() {
  if (!auto) return
  cancelMyTimeout()

  postTimeout = setTimeout(() => {
    postTimeout = null

    var selector = 'span[aria-label="' + state.lastCompany + '"]'
    var companyEle = doc.querySelector(selector)
    if (companyEle) {
      if (infiltrationStart) {
        console.info(`FAILED INFILTRATION - ${((new Date().valueOf() - infiltrationStart) / 1000).toFixed(1)} sec, last was ${last_title}`);
        infiltrationStart = 0
      }
      companyEle.click()
      postTimeout = setTimeout(() => {
        postTimeout = null
        var btn = Array.from(doc.querySelectorAll('button')).find(x => x.innerText.indexOf('Infiltrate Company') >= 0)
        if (btn) btn[Object.keys(btn)[1]].onClick({ isTrusted: true })
      }, 1000)
    }
  }, 1000)
}

function refillhealth() {
	
  if (!auto) return
  cancelMyTimeout()
    console.log("going to hospital");

  postTimeout = setTimeout(() => {
    postTimeout = null
	console.log("function hospital: selecting hospital on map")
    var selector = 'span[aria-label="Hospital"]'
    var HospitalEle = doc.querySelector(selector)
	console.log("function hospital: HospitalEle ", HospitalEle)
	
    if (HospitalEle) {
      if (infiltrationStart) {
        infiltrationStart = 0
      }
      HospitalEle.click()
      postTimeout = setTimeout(() => {
        postTimeout = null
        var btn = Array.from(doc.querySelectorAll('button')).find(x => x.innerText.indexOf('Get treatment') >= 0)
        if (btn) btn[Object.keys(btn)[1]].onClick({ isTrusted: true })
      }, 1000)
    }
  }, 1000)	
}	

  


// accept money bonus, hand off to acceptReputation() if repFaction is set
function acceptMoney(msg) {
  if (!auto) return
  if (postTimeout) return

  //console.log('acceptMoney:', msg)
  cancelMyTimeout()

  if (repFaction && repFaction.length) {
	console.log("starting function accept reputation");
    acceptReputation()
    return
  }

  postTimeout = setTimeout(() => {
    //console.log('acceptMoney()', msg)
    cancelMyTimeout()
    var btn = Array.from(doc.querySelectorAll('button')).find(x => x.innerText.indexOf('Sell for') >= 0)
    if (btn) {
      if (infiltrationStart) {
        console.info(`SUCCESSFUL INFILTRATION - ${((new Date().valueOf() - infiltrationStart) / 1000).toFixed(1)} sec: ${btn.innerText}`);
        infiltrationStart = 0
      }
      btn[Object.keys(btn)[1]].onClick({ isTrusted: true })
    } else {
      console.log(`Failure!  ${ms}`)
    }
	//refillhealth();
    selectCompany();
  }, 500)
}

// accept reputation bonus
function acceptReputation() {
  cancelMyTimeout()

  postTimeout = setTimeout(() => {
    postTimeout = null

    // var e = Array.from(doc.querySelectorAll('[role="button"]')).find(x => x.innerText.indexOf('None') >= 0);
    var e = Array.from(doc.querySelectorAll('[role="combobox"]')).find(x => x.innerText.indexOf('none') >= 0);
	if (typeof(e) == 'undefined')
	{
    var e = Array.from(doc.querySelectorAll('[role="combobox"]')).find(x => x.innerText.indexOf(repFaction) >= 0);
	}
	var datetime = new Date().today() + " @ " + new Date().timeNow();
	// console.log(datetime, " function acceptReputation: e ",e);
	// console.log(datetime, " function acceptReputation: repFaction ", repFaction);
    if (e) {
      e[Object.keys(e)[1]].onKeyDown(new KeyboardEvent('keydown', { 'key': ' ' }));
      postTimeout = setTimeout(() => {
        var e2 = Array.from(doc.querySelectorAll('li[role="option"]')).find(x => x.innerText.indexOf(repFaction) >= 0)
		// console.log("function acceptReputation: e2 ", e2);
        e2.click()
        postTimeout = setTimeout(() => {
          var btn = Array.from(doc.querySelectorAll('button')).find(x => x.innerText.indexOf('Trade for') >= 0)
		  // console.log("function acceptReputation: btn ",btn);
          if (btn) {
            btn[Object.keys(btn)[1]].onClick({ isTrusted: true })
            if (infiltrationStart) {
              console.info(`SUCCESSFUL INFILTRATION - ${((new Date().valueOf() - infiltrationStart) / 1000).toFixed(1)} sec - ${btn.innerText}`, repFaction);
              infiltrationStart = 0
            }
          }
        })
      }, 500)
    }
  }, 1000)
}


// For todays date;
Date.prototype.today = function () { 
    return ((this.getDate() < 10)?"0":"") + this.getDate() +"/"+(((this.getMonth()+1) < 10)?"0":"") + (this.getMonth()+1) +"/"+ this.getFullYear();
}

// For the time now
Date.prototype.timeNow = function () {
     return ((this.getHours() < 10)?"0":"") + this.getHours() +":"+ ((this.getMinutes() < 10)?"0":"") + this.getMinutes() +":"+ ((this.getSeconds() < 10)?"0":"") + this.getSeconds();
}

function cancelMyTimeout() {
  if (postTimeout) {
    clearTimeout(postTimeout)
    postTimeout = null
  }
}
