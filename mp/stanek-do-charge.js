/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog('stanek.charge');
	ns.tail();

	let frags = ns.args.map(a => a.split(','));
	ns.print(`Charging ${frags}`);
	for (let i = 0; i < 50; i++) {
		ns.print(`Charge ${i}...`);
		for (let f of frags)
			await ns.stanek.charge(f[0], f[1]);
	}
}