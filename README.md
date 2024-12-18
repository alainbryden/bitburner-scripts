# Insight's Scripts
Welcome to Insight's Bitburner scripts - one of the Bitburner scripts of all time. Hosted on my personal github because all the best hackers dox themselves.

# Downloading the whole repository

If you manually `nano git-pull.js` from the terminal and copy the [contents of that script](https://raw.githubusercontent.com/alainbryden/bitburner-scripts/main/git-pull.js), you should be able to run it once and download the rest of the files I use. Early-game, many will be useless because they are only enabled by late-game features, but they shouldn't give you too many problems just being there.

# Running scripts

If you `run autopilot.js` from the terminal, it will start several other scripts.

You can think of this as the "master orchestrator" script. It will kick off `daemon.js` (your primary hacking script), which in turn kicks off several other helper-scripts. It will monitor your progress throughout the game, and take special actions when it can. I don't want to spoil too much for those new to the game, but it's worth mentioning that `SF4` is not required, but is highly-recommended to get the full benefit of this script.

Most scripts can also be run on their own, but are primarily designed to be orchestrated by `autopilot.js` or `daemon.js`.

## Manually run scripts

Some scripts are meant to be manually run as needed. Most scripts take arguments to tweak or customize their behaviour based on your preferences or special circumstance. More on this [below](#customizing-script-behaviour-basic).
Run scripts with the `--help` flag to get a list of their arguments, default values, and a brief description of each:
![image](https://user-images.githubusercontent.com/2285037/166085058-952b0805-cf4e-4548-8829-1e1ebeb5428b.png)
You will also see an error-version of this dialog if you make a mistake in how you run the script.

If you have personal preference and wish to "permanently" change the configuration of one of my scripts, you can do so without sacrificing your ability to "git-pull.js" the latest - simply [create a custom `config.txt`](https://github.com/alainbryden/bitburner-scripts/edit/main/README.md#config-files) file for the script.

_Note:_ `autopilot.js` (and in turn, `daemon.js`) will already run many instances of scripts with default arguments. If you wish to run them with special arguments, you must either kill the default version or simply run scripts with your desired arguments **before** starting daemon.js. Daemon.js will only start scripts that are not already running (regardless of the arguments of the currently running instance.)

## Brief description of Scripts

Here are scripts that you may want to manually run, roughly in the order in which you'll want to experiment with them:

- `git-pull.js` - Hopefully you used this to download the scripts. Run it whenever you want to update.
- `scan.js` - Shows you the entire server network and important information about each server. A nice replacement for the built-in `scan` and/or `scan-analyze` commands, with support for unlimited depth.
- `autopilot.js` - Plays the game for you (more or less).
- `daemon.js` - Automates hacking and infrastructure, and kicking off various scripts to take advantage of other mechanics in the game as you unlock them.
- `casino.js` - The first time you run this may come as a surprise, it will play blackjack and reload the game if it loses (automated save-scumming). Once you win 10b, you cannot enter the casino any more. Great way to boost your progress once you make the initial 200k needed to travel to Aevum and use the casino. For best performance, run `kill-all-scripts.js` before you run this, since other running scripts slow down the game's load time.
- `reserve.js` - A simple way to reserve money across all scripts, in case you wanted to be certain to save up for something. e.g. `run reserve.js 200k` will reserve the $200,000 needed to get `casino.js` going.
- `kill-all-scripts.js` - Kills all scripts running on home and remote servers, and also removes files that were copied to remote servers.
- `faction-manager.js` - (Requires SF4) Run this periodically to find out how many augmentations you can currently afford. There are many command line options available to tweak the sort of augmentations you wish to prioritize. Run with `--purchase` to pull the trigger if you're ready to ascend.
- `work-for-factions.js` - (Requires SF4) Daemon.js will start a version of this to make sure your "focus" work goes to good use, but often you'll want to run with your own arguments to specify what kind of work you want to be doing, depending on your goals for the current BitNode.
- `crime.js` - (Requires SF4) While `work-for-factions.js` will do crime as-needed, you can use this instead to do nothing but crime.
- `ascend.js` - (Requires SF4) A nearly-fully-automated way to ascend. Takes care of all the things you may or may not have known you wanted to do before installing augmentations and resetting.
- `spend-hacknet-hashes.js` - (Requires SF9) Many scripts will launch this automatically, but you can start your own instances to focus on purchasing the hash upgrades you want in your current situation. Many aliases for this exist below.
- `farm-intelligence.js` - (Requires SF4, SF5) Contains a script that can execute one or more of the best known methods to farm intelligence experience.
  - Note that the current best method (soft reset loop) is most effective if you delete all scripts except this one (and helpers.js which it relies on) before running. You can do this quickly by modifying cleanup.js to run on all files instead of just /Temp/. You then would have to restore scripts by nano'ing git-pull as when you started out.
- `cleanup.js` - Use this to clear out your temp folder (which contains hundreds of miniature scripts generated by the main scripts). Useful to reduce your save file size before exporting.
- `grep.js` - Use this to search one or all files for certain text. Handy if you are trying to figure out e.g. what script spend hashes, or care about the TIX api.
- `run-command.js` - Useful for testing a bit of code from the terminal without having to create a new script. Creating the alias `alias do="run run-command.js"` makes this extra useful. e.g. `do ns.getPlayer()` will print all the player's info to the terminal. `do ns.getServer('joesguns')` will print all info about that server to the terminal.

If you want more information about any script, try reading the source. I do my best to document things clearly. If it's not clear, feel free to raise an issue.

## Customizing Script Behaviour (Basic)
Most scripts are designed to be configured via command line arguments. (Such as using `run host-manager.js --min-ram-exponent 8` to ensure no servers are purchased with less than 2^8 GB of RAM)

Default behaviours are to try to "balance" priorities and give most things an equal share of budget / RAM, but this isn't always ideal, especially in bitnodes that cripple one aspect of the game or the other. You can `nano` to view the script and see what the command line options are, or type e.g. `daemon.js --` (dash dash) and hit `<tab>` to get a pop-up auto-completion list. (Make sure your mouse cursor is over the terminal for the auto-complete to appear.)

Near the top of the initializer for `daemon.js`, there are a list of external scripts that are spawned initially, and periodically. Some of these can be commented out if you would rather not have that script run automatically (for example `work-for-factions` if you would like to manually choose how to spend your "focus" times.) Once you've downloaded this file, you should customize it with the default options you like, and comment out the external scripts you don't want to run.

## Aliases

You may find it useful to set up one or more aliases with the default options you like rather than editing the file itself. (Pro-tip, aliases support tab-auto-completion). I personally use the following aliases:

- `alias git-pull="run git-pull.js"`
  - Makes auto-updating just a little easier.
- `alias start="run autopilot.js"`
- `alias stop="home; kill autopilot.js ; kill daemon.js ; run kill-all-scripts.js"`
  - Quick way to start/stop the system. I personally now use `auto` instead of `start` for this alias (auto => autopilot.js).
- `alias sscan="home; run scan.js"`
  - Makes it a little quicker to run this custom-scan routine, which shows the entire network, stats about servers, and provides handy links for jumping to servers or backdooring them.
- `alias do="run run-command.js"`
  - This lets you run ns commands from the terminal, such as `do ns.getPlayer()`, `do Object.keys(ns)` or `do ns.getServerMoneyAvailable('n00dles')`
- `alias reserve="run reserve.js"`
  - Doesn't save many keystrokes, but worth highlighting this script. You can run e.g. `reserve 100m` to globally reserve this much money. All scripts with an auto-spend component should respect this amount and leave it unspent. This is useful if e.g. you're saving up to buy something (SQLInject.exe, a big server, the next home RAM upgrade), saving money to spend at the casino, etc...
- `alias liquidate="home; run stockmaster.js --liquidate; run spend-hacknet-hashes.js --liquidate;"`
  - Quickly sell all your stocks and hacknet hashes for money so that you can spend it (useful before resetting)
- `alias facman="run faction-manager.js"`
  - Quickly see what augmentations you can afford to purchase. Then use `facman --purchase` to pull the trigger.
- `alias buy-daemons="run host-manager.js --run-continuously --reserve-percent 0 --min-ram-exponent 19 --utilization-trigger 0 --tail"`
  - This is an example of how to use host-manager to buy servers for you. In this example, we are willing to spend all our current money  (--reserve-percent 0) if it means buying a server with 2^19 GB ram or more (--min-ram-exponent), even if our scripts aren't using any RAM on the network (--utilization-trigger 0), 
- `alias spend-on-ram="run Tasks/ram-manager.js --reserve 0 --budget 1 --tail"`
- `alias spend-on-gangs="run gangs.js --reserve 0 --augmentations-budget 1 --equipment-budget 1 --tail"`
- `alias spend-on-sleeves="run sleeve.js --aug-budget 1 --min-aug-batch 1 --buy-cooldown 0 --reserve 0 --tail"`
  - Useful to run one or more of these (in your own priority order) after you've spent all you can on augmentations, before resetting.
- `alias spend-on-hacknet="run hacknet-upgrade-manager.js --interval 10 --max-payoff-time 8888h --continuous --tail"`
  - Essentially spends a lot of money upgrading the hacknet. If it doesn't spend enough, increase the --max-payoff-time even more.
- `alias hashes-to-bladeburner="run spend-hacknet-hashes.js --spend-on Exchange_for_Bladeburner_Rank --spend-on Exchange_for_Bladeburner_SP --liquidate --tail"`
- `alias hashes-to-corp-money="run spend-hacknet-hashes.js --spend-on Sell_for_Corporation_Funds --liquidate --tail"`
- `alias hashes-to-corp-research="run spend-hacknet-hashes.js --spend-on Exchange_for_Corporation_Research --liquidate --tail"`
- `alias hashes-to-corp="run spend-hacknet-hashes.js --spend-on Sell_for_Corporation_Funds --spend-on Exchange_for_Corporation_Research --liquidate --tail"`
- `alias hashes-to-hack-server="run spend-hacknet-hashes.js --liquidate --spend-on Increase_Maximum_Money --spend-on Reduce_Minimum_Security --spend-on-server"`
  - Useful to set up hashes to automatically get spent on one or more things as you can afford them. Omit --liquidate if you want to save up hashes to spend yourself, and only want to spend them when you reach capacity to avoid wasting them.
- `alias stock="run stockmaster.js --fracH 0.001 --fracB 0.1 --show-pre-4s-forecast --noisy --tail --reserve 100000000"`
  - Useful in e.g. BN8 to invest all cash in the stock market, and closely track progress. _(Also reserves 100m to play blackjack at the casino so you can build up cash quickly. Pro-tip: Save if you win, and just reload (or soft-reset if you hate save-scumming) when you lose it all to get your money back.)_
- `alias crime="run crime.js --tail --fast-crimes-only"`
  - Start an auto-crime loop. (Requires SF4 a.k.a. Singularity access, like so many of my scripts.)
- `alias work="run work-for-factions.js --fast-crimes-only"`
  - Auto-work for factions. Will also do crime loops as deemed necessary. (Note, daemon will start this automatically as well)
- `alias invites="run work-for-factions.js --fast-crimes-only --get-invited-to-every-faction --prioritize-invites --no-coding-contracts"`
  - Tries to join as many factions as possible, regardless of whether you have un-purchased augmentations from them.
- `alias xp="run daemon.js -vx --tail --no-share"`
  - Runs daemon in a way that focuses on earning hack XP income as quickly as possible. Only practical when you have a lot of home-ram.
- `alias start-tight="run daemon.js --looping-mode --recovery-thread-padding 30 --cycle-timing-delay 2000 --queue-delay 10 --stock-manipulation-focus --tail --silent-misfires --initial-max-targets 64"`
  - Let this be a hint as to how customizable some of these scripts are (without editing the source code). The above alias is powerful when you are end-of-bn and your hacking skill is very high (8000+), so hack/grow/weaken times are very fast (milliseconds). You can greatly increase productivity and reduce lag by switching to this `--looping-mode` which creates long-lived hack/grow/weaken scripts that run in a loop. This, in addition to the tighter cycle-timing makes them more vulnerable to misfiring (completing out-of-order), but adding recovery thread padding (a multiple on the number of grow/weaken threads to use) can quickly recover from misfires. Note that if you don't yet have enough home-ram to support such a high recovery-thread multiple, you can start lower (5 or 10) then buy more home ram and work your way up.
- `alias ascend="run ascend.js --install-augmentations"`
  - A good way to finish your node. I personally prioritize augmentations when resetting, because I have all SF bonuses unlocked, but until you have SF11.3 for aug cost reduction, you may want to use the `--prioritize-home-ram` flag which prioritizes upgrading home RAM as much as possible before buying as many augmentations as possible.

## Config Files

Persistent Custom Configurations (script.js.config.txt files) can be specified to override the default args specified by the "args schema" in each script.

The order in which argument values are determined are:
1. Arguments provided at the command line (or in the alias) take priority
2. If no override is provided at the command line, any value in the config file is used.
3. If no config file value is present, the default in the source (argsSchema) is used.
   - Note that some defaults are set to `null` in the args schema to be overridden with more complex defaulting behaviour elsewhere in the script.

### Format Specifications
The file should have the name `some-script-name.js.config.txt` (i.e. append `.config.txt` to the name of the script you are configuring)

Your config file should either of the following two formats
1. A dictionary e.g.: `{ "string-opt": "value", "num-opt": 123, "array-opt": ["one", "two"] }`
2. An array of dict entries (2-element arrays) e.g.: `[ ["string-opt", "value"], ["num-opt", 123], ["array-opt", ["one", "two"]] ]` +

You are welcome to use line breaks and spacing to make things more human readable, so long as it is able to be parsed by JSON.parse (when in doubt, built it in code and generate it with JSON.stringify).

## Customizing Script Code (Advanced)

I encourage you to make a fork and customize scripts to your own needs / liking. Please don't make a PR back to me unless you truly think it's something all would benefit from. If you fork the repository, you can update the `git-pull.js` source to include your github account as the default, or set an alias that specifies this via command-line (e.g. `alias git-pull="run git-pull.js --github mygitusername --repository bitburner-scripts`). This way you can auto-update from your fork and only merge my latest changes when you're ready.


# Disclaimer

This is my own repository of scripts for playing Bitburner.
I often go to some lengths to make them generic and customizable, but am by no means providing these scripts as a "service" to the Bitburner community.
It's meant as an easy way for me to share code with friends, and track changes and bugs in my scripts.

- If you wish to use my scripts or copy from them, feel free!
- If you think you found a bug in them and want to let me know, awesome!
- Please don't be insulted if you make a feature request, bug report, or pull request that I decline to act on.
While I do like my work to be helpful to others and re-used, I am only willing to put so much effort into customizing it to others' specific needs or whims.
You should fork the code, and start tweaking it the way you want it to behave. That's more in the spirit of the game!

Hit up the Bitburner Discord with any questions:
- Invite to Bitburner Disccord: https://discord.com/invite/TFc3hKD
- Link to the channel for these scripts: [Bitburner#alains-scripts](https://discord.com/channels/415207508303544321/935667531111342200)

Many helpful folks in there are familiar with my scripts or ones similar to them and can address your questions and concerns far quicker than I can.
