import { log, getConfiguration, getNsDataThroughFile } from './helpers.js'

const argsSchema = [
	['clear', false], // If set to true, will clear whatever layout is already there and create a new one
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

	// This is probably a game bug, but we can purchase stanek whenever we want to, even if we already have other augs.
	/* NOTE: Stanek's gift is not granted until the achievement is installed, so best not do this here, but before ascending.
	const success = await getNsDataThroughFile(ns, 'ns.singularity.purchaseAugmentation(ns.args[0], ns.args[1])',
		'/Temp/singularity-purchaseAugmentation.txt', ["Church of the Machine God", "Stanek's Gift - Genesis"]);
	if (success)
		log(ns, `SUCCESS: Accepted Stanek's Gift by purchasing the augmentation "Stanek's Gift - Genesis"`, true);
	else
		log(ns, `INFO: Could not purchase "Stanek's Gift - Genesis" - either this exploit was patched, or you've already done this.`);
	*/

	// Find the saved layout that best matches 
	const height = await getNsDataThroughFile(ns, 'ns.stanek.giftHeight()', '/Temp/stanek-giftHeight.txt');
	const width = await getNsDataThroughFile(ns, 'ns.stanek.giftWidth()', '/Temp/stanek-giftWidth.txt');
	const usableLayouts = layouts.filter(l => l.height <= height && l.width <= width);
	const bestLayout = usableLayouts.sort((l1, l2) => // Use the layout with the least amount of unused rows/columns
		(height - l1.height + width - l1.width) - (height - l2.height + width - l2.width))[0];
	log(ns, `Best layout found for current Stanek grid dimentions (height: ${height} width: ${width}) ` +
		`has height: ${bestLayout.height} width: ${bestLayout.width} fragments: ${bestLayout.fragments.length}`);

	// Place the layout
	if (options['clear']) {
		await getNsDataThroughFile(ns, 'ns.stanek.clearGift() || true', '/Temp/stanek-clearGift.txt');
		log(ns, 'Cleared any existing stanek layout.');
	}
}

const layouts = [
	{
		height: 3, width: 3, fragments: [
			{ "id": 1, "x": 0, "y": 0, "rotation": 3 },
			{ "id": 25, "x": 1, "y": 0, "rotation": 3 },
		]
	}, {
		height: 5, width: 5, fragments: [
			{ "id": 1, "x": 0, "y": 0, "rotation": 3 },
			{ "id": 25, "x": 1, "y": 0, "rotation": 3 },
		]
	},
];