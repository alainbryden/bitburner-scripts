const argsSchema = [
    ['github', 'alainbryden'],
    ['repository', 'bitburner-scripts'],
    ['branch', 'main'],
    ['download', []], // By default, all files returned by ns.ls() will be downloaded. Override with just a subset of files here
    ['new-file', []], // By default, only files returned by ns.ls() will be downloaded. You can add additional files to seek out here.
    ['subfolder', ''], // Can be set to download to a sub-folder that is not part of the remote repository structure
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
 * TODO: Some way to list all files in the repository and/or download them all. **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const baseUrl = `https://raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`;
    const filesToDownload = options['new-file'].concat(options.download.length > 0 ? options.download : ns.ls('home')
        .filter(name => !name.endsWith(".exe") && !name.endsWith(".msg") && !name.endsWith(".lit") && !name.startsWith("/Temp/")));
    for (const localFilePath of filesToDownload) {
        const remoteFilePath = baseUrl + localFilePath.substr(options.subfolder.length);
        ns.print(`Trying to update "${localFilePath}" from ${remoteFilePath} ...`);
        if (await ns.wget(`${remoteFilePath}?ts=${new Date().getTime()}`, localFilePath))
            ns.tprint(`SUCCESS: Updated "${localFilePath}" to the latest from ${remoteFilePath}`);
        else
            ns.tprint(`WARNING: "${localFilePath}" was not updated. (Currently running or not located at ${remoteFilePath} )`)
    }
}