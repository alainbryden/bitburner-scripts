import { log, getConfiguration, getNsDataThroughFile } from './helpers.js'

const argsSchema = [
    ['clear', false], // If set to true, will clear whatever layout is already there and create a new one
    ['force-width', null], // Force the layout less than or equal to the specified width
    ['force-height', null], // Force the layout less than or equal to the specified height
];
export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    // Check if stanek was previously placed
    if (!options['clear']) {
        const fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()');
        if (fragments.length > 0)
            return log(ns, `WARNING: Nothing to do, you've already populated Stanek's Gift. Exiting...`, true);
    }

    // Find the saved layout that best matches 
    const height = options['force-height'] || await getNsDataThroughFile(ns, 'ns.stanek.giftHeight()');
    const width = options['force-width'] || await getNsDataThroughFile(ns, 'ns.stanek.giftWidth()');
    const usableLayouts = layouts.filter(l => l.height <= height && l.width <= width);
    const bestLayout = usableLayouts.sort((l1, l2) => // Use the layout with the least amount of unused rows/columns
        (height - l1.height + width - l1.width) - (height - l2.height + width - l2.width))[0];
    log(ns, `Best layout found for current Stanek grid dimentions (height: ${height} width: ${width}) ` +
        `has height: ${bestLayout.height} width: ${bestLayout.width} fragments: ${bestLayout.fragments.length}`);

    // Clear any prior layout if enabled
    if (options['clear']) {
        await getNsDataThroughFile(ns, 'ns.stanek.clearGift() || true', '/Temp/stanek-clearGift.txt');
        log(ns, 'Cleared any existing stanek layout.');
    }

    // Place the layout
    log(ns, `Placing ${bestLayout.fragments.length} fragments:\n` + JSON.stringify(bestLayout.fragments));
    const result = await getNsDataThroughFile(ns,
        'JSON.parse(ns.args[0]).reduce((t, f) => ns.stanek.placeFragment(f.x, f.y, f.rotation, f.id) && t, true)',
        '/Temp/stanek-placeFragments.txt', [JSON.stringify(bestLayout.fragments)]);
    if (result)
        log(ns, `SUCCESS: Placed ${bestLayout.fragments.length} Stanek fragments.`, true, 'success');
    else
        log(ns, `ERROR: Failed to place one or more fragments. The layout may be invalid.`, true, 'error');
}

// DISCLAIMER: These layouts are mostly hack focused, but bring in additional important stats as there is room
const layouts = [ // NOTE: Width appears to be always the same as, or one more than height.
    {
        "height": 2, "width": 3, "fragments": [ // BN 13.1 is this small
            { "id": 0, "x": 0, "y": 0, "rotation": 0 } // Hacking Mult
        ]
    }, {
        "height": 3, "width": 3, "fragments": [
            { "id": 1, "x": 0, "y": 0, "rotation": 3 }, // Hacking Mult
            { "id": 25, "x": 1, "y": 0, "rotation": 3 }, // Reputation
        ]
    }, {
        "height": 3, "width": 4, "fragments": [ // Note: Possible to fit 3 fragments, see "alternative layouts" below
            { "id": 0, "x": 0, "y": 0, "rotation": 1 }, // Hacking Mult
            { "id": 1, "x": 2, "y": 0, "rotation": 1 } // Hacking Mult
        ]
    }, {
        "height": 4, "width": 4, "fragments": [ // Note: Possible to fit 4 fragments, but have to sacrifice a hacking mult piece
            { "id": 0, "x": 0, "y": 0, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 0, "y": 2, "rotation": 0 }, // Hacking Mult
            { "id": 25, "x": 2, "y": 0, "rotation": 3 } // Reputation
        ]
    }, {
        "height": 4, "width": 5, "fragments": [
            { "id": 0, "x": 0, "y": 0, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 0, "y": 2, "rotation": 0 }, // Hacking Mult
            { "id": 25, "x": 3, "y": 1, "rotation": 3 }, // Reputation
            { "id": 104, "x": 2, "y": 0, "rotation": 0 }, // Booster *new*
        ]
    }, {
        "height": 5, "width": 5, "fragments": [
            { "id": 0, "x": 0, "y": 0, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 1, "y": 2, "rotation": 0 }, // Hacking Mult
            { "id": 25, "x": 3, "y": 2, "rotation": 3 }, // Reputation
            { "id": 105, "x": 0, "y": 2, "rotation": 1 }, // Booster
            { "id": 100, "x": 2, "y": 0, "rotation": 0 }, // Booster *new*
        ]
    }, {
        // NOTE: Things get pretty subjective after this. Should we prioritize boosting hacking multi or adding more stats?
        //       I've decided to start by adding in Hacking Speed, Hacknet Production + Cost as 3 stats more important than just more boost
        "height": 5, "width": 6, "fragments": [
            { "id": 0, "x": 3, "y": 0, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 3, "y": 3, "rotation": 0 }, // Hacking Mult
            { "id": 5, "x": 4, "y": 1, "rotation": 1 }, // Hacking Speed *new*
            { "id": 20, "x": 0, "y": 4, "rotation": 0 }, // Hacknet Production *new*
            { "id": 21, "x": 0, "y": 1, "rotation": 0 }, // Hacknet Cost Reduction *new*
            { "id": 25, "x": 0, "y": 0, "rotation": 2 }, // Reputation
            { "id": 102, "x": 0, "y": 2, "rotation": 2 } // Booster
        ]
    }, {
        "height": 6, "width": 6, "fragments": [
            { "id": 0, "x": 0, "y": 2, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 2, "y": 2, "rotation": 1 }, // Hacking Mult
            { "id": 5, "x": 3, "y": 3, "rotation": 1 }, // Hacking Speed
            { "id": 20, "x": 5, "y": 2, "rotation": 1 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 3, "y": 0, "rotation": 2 }, // Reputation
            { "id": 103, "x": 0, "y": 4, "rotation": 2 }, // Booster
            { "id": 104, "x": 2, "y": 0, "rotation": 1 } // Booster *new*
        ]
    }, { // Special thanks to @Ansopedi (a.k.a. Zoëkeeper) for solving for this layout
        "height": 6, "width": 7, "fragments": [
            { "id": 0, "x": 3, "y": 2, "rotation": 1 }, // Hacking Mult
            { "id": 1, "x": 1, "y": 3, "rotation": 0 }, // Hacking Mult
            { "id": 5, "x": 4, "y": 1, "rotation": 1 }, // Hacking Speed
            { "id": 6, "x": 0, "y": 0, "rotation": 0 }, // Hack power *new*
            { "id": 7, "x": 4, "y": 0, "rotation": 2 }, // Grow power *new*
            { "id": 20, "x": 6, "y": 2, "rotation": 1 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 4, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 0, "y": 1, "rotation": 1 }, // Reputation
            { "id": 101, "x": 2, "y": 4, "rotation": 2 }, // Booster
            { "id": 102, "x": 1, "y": 1, "rotation": 0 }, // Booster
        ]
    }, { // Note: Late BN12, as Stanek gets bigger, Bladeburner also becomes a faster win condition, so we start adding those stats
        "height": 7, "width": 7, "fragments": [
            { "id": 0, "x": 1, "y": 5, "rotation": 2 }, // Hacking Mult
            { "id": 1, "x": 3, "y": 3, "rotation": 0 }, // Hacking Mult
            { "id": 5, "x": 0, "y": 4, "rotation": 3 }, // Hacking Speed
            { "id": 6, "x": 0, "y": 0, "rotation": 1 }, // Hack power
            { "id": 7, "x": 1, "y": 1, "rotation": 1 }, // Grow power
            { "id": 20, "x": 1, "y": 0, "rotation": 2 }, // Hacknet Production
            { "id": 21, "x": 3, "y": 1, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 5, "y": 4, "rotation": 3 }, // Reputation
            { "id": 30, "x": 3, "y": 5, "rotation": 2 }, // Bladeburner Stats *new*
            { "id": 101, "x": 5, "y": 0, "rotation": 3 }, // Booster
            { "id": 106, "x": 1, "y": 2, "rotation": 3 }, // Booster
        ]
    }, {
        "height": 7, "width": 8, "fragments": [
            { "id": 0, "x": 4, "y": 1, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 4, "y": 4, "rotation": 3 }, // Hacking Mult
            { "id": 5, "x": 0, "y": 2, "rotation": 0 }, // Hacking Speed
            { "id": 6, "x": 3, "y": 0, "rotation": 2 }, // Hack power
            { "id": 7, "x": 2, "y": 0, "rotation": 0 }, // Grow power
            { "id": 14, "x": 0, "y": 3, "rotation": 1 }, // Dexterity *new*
            { "id": 16, "x": 5, "y": 5, "rotation": 2 }, // Agility *new*
            { "id": 20, "x": 0, "y": 6, "rotation": 0 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 6, "y": 0, "rotation": 3 }, // Reputation
            { "id": 30, "x": 2, "y": 4, "rotation": 0 }, // Bladeburner Stats
            { "id": 103, "x": 4, "y": 3, "rotation": 0 }, // Booster
            { "id": 105, "x": 1, "y": 2, "rotation": 0 }, // Booster
        ]
    }, { // Adds Charisma, which even a small boost makes a huge difference (hours) in grinding company rep
        // TODO: Consider adding charisma boosts a little earlier on in the prior 2 layouts.
        "height": 8, "width": 8, "fragments": [ // ~BN 12.50
            { "id": 0, "x": 3, "y": 0, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 2, "y": 2, "rotation": 1 }, // Hacking Mult
            { "id": 5, "x": 0, "y": 0, "rotation": 3 }, // Hacking Speed
            { "id": 6, "x": 7, "y": 2, "rotation": 1 }, // Hack power
            { "id": 7, "x": 4, "y": 5, "rotation": 3 }, // Grow power
            { "id": 14, "x": 3, "y": 4, "rotation": 3 }, // Dexterity
            { "id": 16, "x": 5, "y": 1, "rotation": 1 }, // Agility
            { "id": 18, "x": 6, "y": 5, "rotation": 1 }, // Charisma *new*
            { "id": 20, "x": 0, "y": 3, "rotation": 3 }, // Hacknet Production
            { "id": 21, "x": 6, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 2, "y": 5, "rotation": 3 }, // Reputation
            { "id": 30, "x": 0, "y": 6, "rotation": 0 }, // Bladeburner Stats
            { "id": 101, "x": 1, "y": 2, "rotation": 3 }, // Booster
            { "id": 105, "x": 4, "y": 2, "rotation": 1 }, // Booster
            { "id": 106, "x": 1, "y": 0, "rotation": 1 }, // Booster *new* (Thanks @aeroleo)
        ]
    }, { // Took a minute and found a way to cram Defense and Strength in
        "height": 8, "width": 9, "fragments": [
            { "id": 0, "x": 4, "y": 1, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 4, "y": 4, "rotation": 0 }, // Hacking Mult
            { "id": 5, "x": 0, "y": 2, "rotation": 0 }, // Hacking Speed
            { "id": 6, "x": 3, "y": 0, "rotation": 2 }, // Hack power
            { "id": 7, "x": 2, "y": 0, "rotation": 0 }, // Grow power
            { "id": 10, "x": 4, "y": 6, "rotation": 2 }, // Strength *new*
            { "id": 12, "x": 6, "y": 5, "rotation": 0 }, // Defense *new*
            { "id": 14, "x": 1, "y": 5, "rotation": 1 }, // Dexterity
            { "id": 16, "x": 7, "y": 0, "rotation": 3 }, // Agility
            { "id": 18, "x": 3, "y": 4, "rotation": 1 }, // Charisma
            { "id": 20, "x": 0, "y": 3, "rotation": 3 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 4, "y": 3, "rotation": 2 }, // Reputation
            { "id": 30, "x": 2, "y": 5, "rotation": 1 }, // Bladeburner Stats
            { "id": 101, "x": 6, "y": 2, "rotation": 1 }, // Booster
            { "id": 105, "x": 1, "y": 2, "rotation": 0 } // Booster
        ]
    }, { // Ample Space ~ BN 12.85 to get more boosts on all stats
        "height": 9, "width": 9, "fragments": [
            { "id": 0, "x": 4, "y": 1, "rotation": 0 }, // Hacking Mult
            { "id": 1, "x": 4, "y": 4, "rotation": 0 }, // Hacking Mult
            { "id": 5, "x": 0, "y": 2, "rotation": 0 }, // Hacking Speed
            { "id": 6, "x": 4, "y": 0, "rotation": 0 }, // Hack power
            { "id": 7, "x": 2, "y": 0, "rotation": 0 }, // Grow power
            { "id": 10, "x": 7, "y": 2, "rotation": 1 }, // Strength
            { "id": 12, "x": 5, "y": 7, "rotation": 0 }, // Defense
            { "id": 14, "x": 1, "y": 5, "rotation": 1 }, // Dexterity
            { "id": 16, "x": 5, "y": 6, "rotation": 0 }, // Agility
            { "id": 18, "x": 3, "y": 4, "rotation": 1 }, // Charisma
            { "id": 20, "x": 0, "y": 3, "rotation": 3 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 4, "y": 3, "rotation": 2 }, // Reputation
            { "id": 30, "x": 2, "y": 5, "rotation": 1 }, // Bladeburner Stats
            { "id": 101, "x": 1, "y": 7, "rotation": 2 }, // Booster *new*
            { "id": 101, "x": 7, "y": 5, "rotation": 1 }, // Booster
            { "id": 105, "x": 1, "y": 2, "rotation": 0 }, // Booster
            { "id": 105, "x": 6, "y": 0, "rotation": 0 } // Booster *new*
        ]
    }

];

// Not used for anything, but captures our rough priorities when designing the above layouts
const priorities = [
    { id: 25, weight: 13.0 }, /* Faction Rep */
    { id: 0, weight: 12.0 }, /* Hack Mult */
    { id: 1, weight: 11.0 }, /* Hack Mult */
    // Generally prefer adding one of these stats over triple-boosting the above
    { id: 5, weight: 1.15 }, /* Hack Speed */
    { id: 20, weight: 1.14 }, /* Hacknet Prod */
    { id: 21, weight: 1.13 }, /* Hacknet Cost */
    { id: 6, weight: 1.12 }, /* Hack Power */
    { id: 7, weight: 1.11 }, /* Grow Power */
    { id: 30, weight: 1.10 }, /* Bladeburner */
    { id: 16, weight: 1.09 }, /* Agi */
    { id: 14, weight: 1.08 }, /* Dex */
    // Generally prefer additional boost over the below
    { id: 28, weight: 0.99 }, /* Crime Money */
    { id: 18, weight: 0.98 }, /* Cha */
    { id: 10, weight: 0.97 }, /* Str */
    { id: 12, weight: 0.96 }, /* Def */
    { id: 28, weight: 0.95 }, /* Work Money */
]

// Not used, but these alternative layouts favour fitting more stat pieces vs. boosting most important stats, use if you please
const alternativeLayouts = [
    {
        "height": 3, "width": 4, "fragments": [
            { "id": 0, "x": 1, "y": 0, "rotation": 0 }, // Hacking Chance
            { "id": 25, "x": 0, "y": 0, "rotation": 1 }, // Reputation
            { "id": 28, "x": 1, "y": 1, "rotation": 0 }, // Crime Money
        ]
    }, {
        "height": 4, "width": 4, "fragments": [
            { "id": 0, "x": 0, "y": 2, "rotation": 2 }, // Hacking Chance
            { "id": 7, "x": 2, "y": 1, "rotation": 3 }, // Grow power
            { "id": 25, "x": 0, "y": 0, "rotation": 1 }, // Reputation
            { "id": 30, "x": 1, "y": 0, "rotation": 0 }, // Bladeburner
        ]
    }, {
        "height": 6, "width": 6, "fragments": [
            { "id": 0, "x": 0, "y": 2, "rotation": 0 }, // Hacking Chance
            { "id": 1, "x": 0, "y": 4, "rotation": 0 }, // Hacking Chance
            { "id": 5, "x": 2, "y": 1, "rotation": 0 }, // Hacking Speed
            { "id": 6, "x": 2, "y": 0, "rotation": 0 }, // Hack power
            { "id": 7, "x": 2, "y": 3, "rotation": 2 }, // Grow power
            { "id": 20, "x": 5, "y": 1, "rotation": 1 }, // Hacknet Production
            { "id": 21, "x": 0, "y": 0, "rotation": 0 }, // Hacknet Cost Reduction
            { "id": 25, "x": 3, "y": 4, "rotation": 0 }, // Reputation
        ]
    }
]