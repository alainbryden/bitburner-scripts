# Downloading the whole repository

If you manually `nano git-pull.js` from the terminal and copy the [contents of that script](https://raw.githubusercontent.com/alainbryden/bitburner-scripts/main/git-pull.js), you should be able to run it once and download the rest of the files I use. Early-game, many will be useless because they are only enabled by late-game features, but they shouldn't give you too many problems just being there.

## Customizations

I encourage you to make a fork and customize scripts to your own needs / liking. Please don't make a PR back to me unless you truly think it's something all would benefit from. If you fork the repository, you can update `git-pull.js` to include your github account as the default.

# Running scripts

Scripts can mostly be run on their own, but are primarily designed to be orchestrated by `daemon.js`. If you `run daemon.js` from the terminal, it will start several other scripts.

## Customizing
Near the top of the main method, there are a list of scripts that are spanwed initially, and periodically. Some may be commented out (for example host-manager, I like to manually manage when servers are bought lately - but you may wish to re-enable this.) Once you've downloaded this file, you should customize it with the default options you like, and comment out the external scripts you don't want to run.

## Alias

You may find it useful to set up an alias with the default options you like rather than editing the file itself. I personally use:

`alias start="run daemon.js -v --tail --stock-manipulation"`

This way I can just enter `start` in the terminal after each reset, and the rest is handled automatically.


# Disclaimer

This is my own repository of scripts for playing Bitburner.
I often go to some lengths to make them generic and customizable, but am by no means providing these scripts as a "service" to the bitburner community.
It's meant as an easy way for me to share code with friends, and track changes and bugs in my scripts.

- If you wish to use my scripts or copy from them, feel free!
- If you think you found a bug in them and want to let me know, awesome!
- Please don't be insulted if you make a feature request, bug report, or pull request that I decline to act on.
While I do like my work to be helpful to others and re-used, I am only willing to put so much effort into customizing it to others' specific needs or whims.
You should fork the code, and start tweaking it the way you want it to behave. That's more in the spirit of the game!

Hit up the Bitburner Discord with any questions: https://discord.gg/Wjrs92b3
Many helpful folks in there are familiar with my scripts or ones similar to them and can address your questions and concerns far quicker than I can.
