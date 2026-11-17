/** Spawned by dark-w0rm.js on its own server: `link` applies a stasis link, `unlink` removes it. */
import { log } from "../helpers.js";

/** @param {NS} ns */
export async function main(ns) {
  const link = ns.args[0] !== "unlink";
  const result = await ns.dnet.setStasisLink(link);
  const host = ns.getHostname();
  if (result.success) {
    const full = `Stasis link ${link ? "applied to" : "removed from"} ${host}.`;
    log(ns, `SUCCESS: ${full}`, true);
    ns.toast(`DN: Stasis${link ? "" : " off"}: ${host}.`, "success");
  } else {
    ns.print(`${host}: ${result.message}`);
  }
}
