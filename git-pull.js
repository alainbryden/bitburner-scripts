let options;
const argsSchema = [
    ['github', 'alainbryden'],
    ['repository', 'bitburner-scripts'],
    ['branch', 'main'],
    ['download', []], // By default, all supported files in the repository will be downloaded. Override with just a subset of files here
    ['new-file', []], // If a repository listing fails, only files returned by ns.ls() will be downloaded. You can add additional files to seek out here.
    ['subfolder', ''], // Can be set to download to a sub-folder that is not part of the remote repository structure
    ['extension', ['.js', '.ns', '.txt', '.script']], // Files to download by extension
    ['omit-folder', ['Temp/']], // Folders to omit when getting a list of files to update (TODO: This may be obsolete now that we get a list of files from github itself.)
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--download", "--subfolder", "--omit-folder"].includes(lastFlag))
        return data.scripts;
    return [];
}

/** @param {NS} ns 
 * Will try to download a fresh version of every file on the current server.
 * You are responsible for:
 * - Backing up your save / scripts first (try `download *` in the terminal)
 * - Ensuring you have no local changes that you don't mind getting overwritten **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    // Once upon a time, the game API required folders to have a leading slash
    // As of 2.3.1, not only is this no longer needed, but it can break the game.
    if (options.subfolder)
        options.subfolder = trimSlash(options.subfolder); // Remove the leading slash
    const baseUrl = `raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`;
    const filesToDownload = options['new-file'].concat(options.download.length > 0 ? options.download : await repositoryListing(ns));
    for (const localFilePath of filesToDownload) {
        let fullLocalFilePath = pathJoin(options.subfolder, localFilePath);
        const remoteFilePath = `https://` + pathJoin(baseUrl, localFilePath);
        ns.print(`Trying to update "${fullLocalFilePath}" from ${remoteFilePath} ...`);
        if (await ns.wget(`${remoteFilePath}?ts=${new Date().getTime()}`, fullLocalFilePath) && rewriteFileForSubfolder(ns, fullLocalFilePath))
            ns.tprint(`SUCCESS: Updated "${fullLocalFilePath}" to the latest from ${remoteFilePath}`);
        else
            ns.tprint(`WARNING: "${fullLocalFilePath}" was not updated. (Currently running, or not located at ${remoteFilePath}?)`)
    }
    ns.tprint(`INFO: Pull complete. If you have any questions or issues, head over to the Bitburner #alains-scripts Discord channel: ` +
        `https://discord.com/channels/415207508303544321/935667531111342200`);
    // Remove any temp files / scripts from the prior version
    ns.run(pathJoin(options.subfolder, `cleanup.js`));
}

/** Removes leading and trailing slashes from the specified string */
function trimSlash(s) {
    // Once upon a time, the game API required folders to have a leading slash
    // As of 2.3.1, not only is this no longer needed, but it can break the game.
    if (s.startsWith('/'))
        s = s.slice(1);
    if (s.endsWith('/'))
        s = s.slice(0, -1);
    return s;
}

/** Joins all arguments as components in a path, e.g. pathJoin("foo", "bar", "/baz") = "foo/bar/baz" **/
function pathJoin(...args) {
    return trimSlash(args.filter(s => !!s).join('/').replace(/\/\/+/g, '/'));
}

/** @param {NS} ns
 * Rewrites a file with path substitions to handle downloading to a subfolder. **/
export function rewriteFileForSubfolder(ns, path) {
    if (!options.subfolder || path.includes('git-pull.js'))
        return true;
    let contents = ns.read(path);
    // Replace subfolder reference in helpers.js getFilePath:
    contents = contents.replace(`const subfolder = ''`, `const subfolder = '${options.subfolder}/'`);
    // Replace any imports, which can't use getFilePath:
    contents = contents.replace(/from '(\.\/)?(.*)'/g, `from '${pathJoin(options.subfolder, '$2')}'`);
    ns.write(path, contents, 'w');
    return true;
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