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
		const fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()', '/Temp/stanek-activeFragments.txt');
		if (fragments.length > 0)
			return log(ns, `WARNING: Nothing to do, you've already populated Stanek's Gift. Exiting...`, true);
	}

	// Find the saved layout that best matches 
	const height = options['force-height'] || await getNsDataThroughFile(ns, 'ns.stanek.giftHeight()', '/Temp/stanek-giftHeight.txt');
	const width = options['force-width'] || await getNsDataThroughFile(ns, 'ns.stanek.giftWidth()', '/Temp/stanek-giftWidth.txt');
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

// DISCLAIMER: These layouts are decidedly hack focused.
const layouts = [ // NOTE: Width appears to be always the same as, or one more than height.
	{
		"height": 3, "width": 3, "fragments": [
			{ "id": 1, "x": 0, "y": 0, "rotation": 3 }, // Hacking Mult
			{ "id": 25, "x": 1, "y": 0, "rotation": 3 }, // Reputation
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
			{ "id": 104, "x": 2, "y": 0, "rotation": 0 }, // Booster
		]
	}, {
		"height": 5, "width": 5, "fragments": [
			{ "id": 0, "x": 0, "y": 0, "rotation": 0 }, // Hacking Mult
			{ "id": 1, "x": 1, "y": 2, "rotation": 0 }, // Hacking Mult
			{ "id": 25, "x": 3, "y": 2, "rotation": 3 }, // Reputation
			{ "id": 105, "x": 0, "y": 2, "rotation": 1 }, // Booster
			{ "id": 100, "x": 2, "y": 0, "rotation": 0 }, // Booster
		]
	}, {
		// NOTE: Things get pretty subjective after this. Should we prioritize boosting hacking multi or adding more stats?
		//       I've decided to start by adding in Hacking Speed, Hacknet Production + Cost as 3 stats more important than just more boost
		"height": 5, "width": 6, "fragments": [
			{ "id": 0, "x": 3, "y": 0, "rotation": 0 }, // Hacking Mult
			{ "id": 1, "x": 3, "y": 3, "rotation": 0 }, // Hacking Mult
			{ "id": 5, "x": 4, "y": 1, "rotation": 1 }, // Hacking Speed
			{ "id": 20, "x": 0, "y": 4, "rotation": 0 }, // Hacknet Production
			{ "id": 21, "x": 0, "y": 1, "rotation": 0 }, // Hacknet Cost Reduction
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
			{ "id": 104, "x": 2, "y": 0, "rotation": 1 } // Booster
		]
	}, {
		"height": 7, "width": 7, "fragments": [
			{ "id": 0, "x": 1, "y": 5, "rotation": 2 }, // Hacking Mult
			{ "id": 1, "x": 3, "y": 3, "rotation": 0 }, // Hacking Mult
			{ "id": 5, "x": 0, "y": 4, "rotation": 3 }, // Hacking Speed
			{ "id": 6, "x": 0, "y": 0, "rotation": 1 }, // Hack power
			{ "id": 7, "x": 1, "y": 1, "rotation": 1 }, // Grow power
			{ "id": 20, "x": 1, "y": 0, "rotation": 2 }, // Hacknet Production
			{ "id": 21, "x": 3, "y": 1, "rotation": 0 }, // Hacknet Cost Reduction
			{ "id": 25, "x": 5, "y": 4, "rotation": 3 }, // Reputation
			{ "id": 30, "x": 3, "y": 5, "rotation": 2 }, // Bladeburner Stats TODO: Not universally useful
			{ "id": 101, "x": 5, "y": 0, "rotation": 3 }, // Booster
			{ "id": 106, "x": 1, "y": 2, "rotation": 3 }, // Booster
		]
	}, {
		"height": 7, "width": 8, "fragments": [
			{ "id": 0, "x": 3, "y": 2, "rotation": 2 }, // Hacking Chance
			{ "id": 1, "x": 3, "y": 4, "rotation": 2 }, // Hacking Chance
			{ "id": 5, "x": 6, "y": 3, "rotation": 1 }, // Hacking Speed
			{ "id": 6, "x": 2, "y": 1, "rotation": 2 }, // Hack power
			{ "id": 7, "x": 1, "y": 5, "rotation": 2 }, // Grow power
			{ "id": 20, "x": 1, "y": 0, "rotation": 2 }, // Hacknet Production
			{ "id": 21, "x": 0, "y": 2, "rotation": 1 }, // Hacknet Cost Reduction
			{ "id": 25, "x": 5, "y": 0, "rotation": 2 }, // Reputation
			{ "id": 27, "x": 0, "y": 5, "rotation": 0 }, // Work Money
			{ "id": 28, "x": 4, "y": 5, "rotation": 0 }, // Crime Money
			{ "id": 103, "x": 5, "y": 1, "rotation": 1 }, // Booster
			{ "id": 104, "x": 1, "y": 2, "rotation": 0 }, // Booster
		]
	}
];