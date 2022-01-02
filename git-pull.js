let options;
const argsSchema = [
    ['github', 'alainbryden'],
    ['repository', 'bitburner-scripts'],
    ['branch', 'main'],
    ['download', []], // By default, all supported files in the repository will be downloaded. Override with just a subset of files here
    ['new-file', []], // If a repository listing fails, only files returned by ns.ls() will be downloaded. You can add additional files to seek out here.
    ['subfolder', ''], // Can be set to download to a sub-folder that is not part of the remote repository structure
    ['extension', ['.js', '.ns', '.txt', '.script']], // Files to download by extension
    ['omit-folder', ['/Temp/']], // Folders to omit
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
    options = ns.flags(argsSchema);
    const baseUrl = `https://raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`;
    const filesToDownload = options['new-file'].concat(options.download.length > 0 ? options.download : await repositoryListing(ns));
    for (const localFilePath of filesToDownload) {
        const remoteFilePath = baseUrl + localFilePath;
        ns.print(`Trying to update "${localFilePath}" from ${remoteFilePath} ...`);
        if (await ns.wget(`${remoteFilePath}?ts=${new Date().getTime()}`, options.subfolder + '/' + localFilePath))
            ns.tprint(`SUCCESS: Updated "${localFilePath}" to the latest from ${remoteFilePath}`);
        else
            ns.tprint(`WARNING: "${localFilePath}" was not updated. (Currently running or not located at ${remoteFilePath} )`)
    }
}

/** @param {NS} ns 
 * Gets a list of files to download, either from the github repository (if supported), or using a local directory listing **/
async function repositoryListing(ns, folder = '') {
    // Note: Limit of 60 free API requests per day, don't over-do it
    const listUrl = `https://api.github.com/repos/${options.github}/${options.repository}/contents/${folder}?ref=${options.branch}`
    let response = null;
    try {
        response = await fetch(listUrl); // Raw response
        // Expect an array of objects: [{path:"", type:"[file|dir]" },{...},...]
        response = await response.json(); // Deserialized
        // Sadly, we must recursively retrieve folders, which eats into our 60 free API requests per day.
        const folders = response.filter(f => f.type == "dir").map(f => f.path);
        let files = response.filter(f => f.type == "file").map(f => f.path)
            .filter(f => options.extension.some(ext => f.endsWith(ext)));
        ns.print(`The following files exist at ${listUrl}\n${files.join(", ")}`);
        for (const folder of folders)
            files = files.concat((await repositoryListing(ns, folder))
                .map(f => `/${f}`)); // Game requires folders to have a leading slash
        return files;
    } catch (error) {
        if (folder !== '') throw error; // Propagate the error if this was a recursive call.
        ns.tprint(`WARNING: Failed to get a repository listing (GitHub API request limit of 60 reached?): ${listUrl}` +
            `\nResponse Contents (if available): ${JSON.stringify(response ?? '(N/A)')}\nError: ${String(error)}`);
        // Fallback, assume the user already has a copy of all files in the repo, and use it as a directory listing
        return ns.ls('home').filter(name => options.extension.some(ext => f.endsWith(ext)) &&
            !options['omit-folder'].some(dir => name.startsWith(dir)));
    }
}
