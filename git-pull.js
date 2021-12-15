const argsSchema = [
    ['github', 'alainbryden'],
    ['repository', 'bitburner-scripts'],
    ['branch', 'main'],
    ['download', []], // By default, all files returned by ns.ls() will be downloaded. Override with just a subset of files here
    ['new-file', []], // By default, only files returned by ns.ls() will be downloaded. You can add additional files to seek out here.
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns 
 * Will try to download a fresh version of every file on the current server.
 * You are responsible for:
 * - Backing up your save / scripts first (try `download *` in the terminal)
 * - Ensuring you have no local changes that you don't mind getting overwritten
 * - Ensuring scripts are stopped so that the attempt to overwrite them doesn't fail.
 * TODO: Some way to list all files in the repository and/or download them all. **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const baseUrl = `https://raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`
    const filesToDownload = (options.download.length > 0 ? options.download : ns.ls('home')).concat(options['new-file'])
    for (const filename of filesToDownload) {
        ns.print(`Trying to download ${baseUrl}${filename}...`)
        if (await ns.wget(`${baseUrl}${filename}?ts=${new Date().getTime()}`, filename))
            ns.tprint(`SUCCESS: Updated ${filename} to the latest from ${baseUrl}${filename}`)
        else
            ns.tprint(`WARNING: ${filename} was not updated. (Currently running or not located at ${baseUrl}${filename} )`)
    }
}