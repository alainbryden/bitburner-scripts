# Downloading the whole repository

If you manually `nano git-pull.js` from the terminal and copy the [contents of that script](https://raw.githubusercontent.com/alainbryden/bitburner-scripts/main/git-pull.js), you should be able to run it once and download the rest of the files I use. Early-game, many will be useless because they are only enabled by late-game features, but they shouldn't give you too many problems just being there.

# Running scripts

Scripts can mostly be run on their own, but are primarily designed to be orchestrated by `daemon.js`. If you `run daemon.js` from the terminal, it will start several other scripts.

# Customizing Script Behaviour (Basic)
Most scripts are designed to be configured via command line arguments. (Such as using `run host-manager.js --min-ram-exponent 8` to ensure no servers are purchased with less than 2^8 GB of RAM)

Default behaviours are to try to "balance" priorities and give most things an equal share of budget / RAM, but this isn't always ideal, especially in bitnodes that cripple one aspect of the game or the other. You can `nano` to view the script and see what the command line options are, or type e.g. `daemon.js --` (dash dash) and hit `<tab>` to get a pop-up auto-completion list. (Make sure your mouse cursor is over the terminal for the auto-complete to appear.)

Near the top of the initializer for `daemon.js`, there are a list of external scripts that are spawned initially, and periodically. Some of these can be commented out if you would rather not have that script run automatically (for example `work-for-factions` if you would like to manually choose how to spend your "focus" times.) Once you've downloaded this file, you should customize it with the default options you like, and comment out the external scripts you don't want to run.

## Aliases

You may find it useful to set up one or more aliases with the default options you like rather than editing the file itself. (Pro-tip, aliases support tab-auto-completion). I personally use the following aliases:

- `alias git-pull="run git-pull.js"`
  - Makes auto-updating just a little easier.
- `alias start="run daemon.js -v --stock-manipulation --tail"`
  - This way I can just enter `start` in the terminal after each reset, and the rest is handled automatically.
- `alias stop="home; kill daemon.js -v --stock-manipulation; run cascade-kill.js"`
- `alias sscan="home; run scan.js"`
  - Makes it a little quicker to run this custom-scan routine, which shows the entire network, stats about servers, and provides handy links for jumping to servers or backdooring them.
- `alias do="run run-command.js"`
  - This lets you run ns commands from the terminal, such as `do ns.getPlayer()`, `do Object.keys(ns)` or `do ns.getServerMoneyAvailable('n00dles')`
- `alias reserve="run reserve.js"`
  - Doesn't save many keystrokes, but worth highlighting this script. You can run e.g. `reserve 100m` to globally reserve this much money. All scripts with an auto-spend component should respect this amount and leave it unspent. This is useful if e.g. you're saving up to buy something (SQLInject.exe, a big server, the next home RAM upgrade), saving money to spend at the casino, etc...
- `alias liquidate="home; run stockmaster.js --liquidate; run spend-hacknet-hashes.js --liquidate;"`
  - Quickly sell all your stocks and hacknet hashes for money so that you can spend it (useful before resetting)
- `facman="run faction-manager.js"`
  - Quickly see what augmentations you can afford to purchase. Then use `facman --purchase` to pull the trigger.
- `alias spend-on-ram="run Tasks/ram-manager.js --reserve 0 --budget 1 --tail"`
- `alias spend-on-gangs="run gangs.js --reserve 0 --augmentations-budget 1 --equipment-budget 1 --tail"`
- `alias spend-on-sleeves="run sleeve.js --aug-budget 1 --min-aug-batch 1 --buy-cooldown 0 --reserve 0 --tail"`
  - Useful to run one or more of these (in your own priority order) after you've spent all you can on augmentations, before resetting.
- `alias stock="run stockmaster.js --fracH 0.001 --fracB 0.1 --show-pre-4s-forecast --noisy --tail --reserve 100000000"`
  - Useful in e.g. BN8 to invest all cash in the stock market, and closely track progress. _(Also reserves 100m to play blackjack at the casino so you can build up cash quickly. Pro-tip: Save if you win, and just reload (or soft-reset if you hate save-scumming) when you lose it all to get your money back.)_
- `alias crime="run crime.js --tail --fast-crimes-only"`
  - Start an auto-crime loop. (Requires SF4 a.k.a. Singularity access, like so many of my scripts.)
- `alias work="run work-for-factions.js --fast-crimes-only"`
  - Auto-work for factions. Will also do crime loops as deemed necessary. (Note, daemon will start this automatically as well)
- `alias start-tight="run daemon.js --looping-mode --recovery-thread-padding 30 --cycle-timing-delay 2000 --queue-delay 10 --stock-manipulation-focus --tail --silent-misfires --initial-max-targets 64"`
  - Let this be a hint as to how customizable some of these scripts are (without editing the source code). The above alias is powerful when you are end-of-bn and your hacking skill is very high (8000+), so hack/grow/weaken times are very fast (milliseconds). You can greatly increase productivity and reduce lag by switching to this `--looping-mode` which creates long-lived hack/grow/weaken scripts that run in a loop. This, in addition to the tighter cycle-timing makes them more vulnerable to misfiring (completing out-of-order), but adding recovery thread padding (a multiple on the number of grow/weaken threads to use) can quickly recover from misfires. Note that if you don't yet have enough home-ram to support such a high recovery-thread multiple, you can start lower (5 or 10) then buy more home ram and work your way up.

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

Hit up the Bitburner Discord with any questions: https://discord.gg/Wjrs92b3
Many helpful folks in there are familiar with my scripts or ones similar to them and can address your questions and concerns far quicker than I can.
