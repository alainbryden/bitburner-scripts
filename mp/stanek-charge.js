/** @param {NS} ns **/
export async function main(ns) {
	let doc = eval('document');
    let tIn = doc.getElementById("terminal-input"),
        tEv = tIn[Object.keys(tIn)[1]];
    let setInput = x => {
        tIn.value = x;
        tEv.onChange({ target: tIn });
    };

	let reserve = ns.args[0] == '-r' ? ns.args[1] : 2;
	let frags = ns.stanek.activeFragments()
		.filter(f => f.id < 100);

	let script = '/scripts/stanek-do-charge.js';
	let threads = Math.floor(ns.getServerMaxRam('home') / ns.getScriptRam(script)) - 2 - reserve;
	let args = frags.map(f => `${f.x},${f.y}`);
	ns.tprint(`Charging ${frags.map(f => f.id)}`);
	setInput(`run ${script} -t ${threads} ${args.join(' ')}`);
}