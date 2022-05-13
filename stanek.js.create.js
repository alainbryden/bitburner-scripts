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

const layouts = [
	{
		"height": 3, "width": 3, "fragments": [
			{ "id": 1, "x": 0, "y": 0, "rotation": 3 },
			{ "id": 25, "x": 1, "y": 0, "rotation": 3 },
		]
	}, {
		"height": 5, "width": 6, "fragments": [
			{ "id": 0, "x": 3, "y": 3, "rotation": 0 },
			{ "id": 1, "x": 0, "y": 2, "rotation": 0 },
			{ "id": 5, "x": 4, "y": 0, "rotation": 1 },
			{ "id": 6, "x": 1, "y": 0, "rotation": 0 },
			{ "id": 7, "x": 0, "y": 0, "rotation": 0 },
			{ "id": 25, "x": 0, "y": 3, "rotation": 0 },
			{ "id": 107, "x": 2, "y": 1, "rotation": 0 },
		]
	}, {
		"height": 6, "width": 6, "fragments": [
			{ "id": 0, "x": 3, "y": 0, "rotation": 0 },
			{ "id": 1, "x": 1, "y": 1, "rotation": 0 },
			{ "id": 5, "x": 0, "y": 1, "rotation": 3 },
			{ "id": 6, "x": 5, "y": 1, "rotation": 3 },
			{ "id": 7, "x": 3, "y": 4, "rotation": 0 },
			{ "id": 10, "x": 3, "y": 2, "rotation": 1 },
			{ "id": 20, "x": 0, "y": 0, "rotation": 0 },
			{ "id": 21, "x": 1, "y": 3, "rotation": 0 },
			{ "id": 25, "x": 0, "y": 4, "rotation": 0 },
		]
	}, {
		"height": 7, "width": 7, "fragments": [
			{ "id": 0, "x": 1, "y": 5, "rotation": 2 },
			{ "id": 1, "x": 3, "y": 3, "rotation": 0 },
			{ "id": 5, "x": 0, "y": 4, "rotation": 3 },
			{ "id": 6, "x": 0, "y": 0, "rotation": 1 },
			{ "id": 7, "x": 1, "y": 1, "rotation": 1 },
			{ "id": 20, "x": 1, "y": 0, "rotation": 2 },
			{ "id": 21, "x": 3, "y": 1, "rotation": 0 },
			{ "id": 25, "x": 5, "y": 4, "rotation": 3 },
			{ "id": 30, "x": 3, "y": 5, "rotation": 2 },
			{ "id": 101, "x": 5, "y": 0, "rotation": 3 },
			{ "id": 106, "x": 1, "y": 2, "rotation": 3 },
		]
	}, {
		"height": 7, "width": 8, "fragments": [
			{ "id": 0, "x": 3, "y": 2, "rotation": 2 },
			{ "id": 1, "x": 3, "y": 4, "rotation": 2 },
			{ "id": 5, "x": 6, "y": 3, "rotation": 1 },
			{ "id": 6, "x": 2, "y": 1, "rotation": 2 },
			{ "id": 7, "x": 1, "y": 5, "rotation": 2 },
			{ "id": 20, "x": 1, "y": 0, "rotation": 2 },
			{ "id": 21, "x": 0, "y": 2, "rotation": 1 },
			{ "id": 25, "x": 5, "y": 0, "rotation": 2 },
			{ "id": 27, "x": 0, "y": 5, "rotation": 0 },
			{ "id": 28, "x": 4, "y": 5, "rotation": 0 },
			{ "id": 103, "x": 5, "y": 1, "rotation": 1 },
			{ "id": 104, "x": 1, "y": 2, "rotation": 0 },
		]
	}
];