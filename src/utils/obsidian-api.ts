import { generalSettings } from './storage-utils';

export interface ObsidianFolder {
    name: string;
    path: string;
}

export async function fetchObsidianFolders(): Promise<ObsidianFolder[]> {
    const { enabled, apiKey, host, port } = generalSettings.obsidianApi;

    if (!enabled || !apiKey) {
        return [];
    }

    let protocol = 'https';
    let cleanHost = host;

    if (host.startsWith('http://')) {
        protocol = 'http';
        cleanHost = host.replace('http://', '');
    } else if (host.startsWith('https://')) {
        protocol = 'https';
        cleanHost = host.replace('https://', '');
    }

    const apiUrl = `${protocol}://${cleanHost}:${port}/vault/`;
    const foldersMap = new Map<string, ObsidianFolder>();
    const visitedPaths = new Set<string>();

    try {
        // Step 1: Fetch the root listing
        const rootResponse = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        });

        if (!rootResponse.ok) {
            throw new Error('Root listing failed: ' + rootResponse.status + ' ' + rootResponse.statusText);
        }

        const rootData = await rootResponse.json();

        if (!rootData || !Array.isArray(rootData.files)) {
            return [];
        }

        // Step 2: Extract ALL folder paths from all entries in the root listing
        // Some API versions return flat paths like "Maths/Chapter-1/" directly
        for (const item of rootData.files) {
            if (typeof item !== 'string') continue;

            if (item.endsWith('/')) {
                const cleanPath = item.replace(/\/+$/, '');
                addFolderAndParents(cleanPath, foldersMap);
            } else if (item.includes('/')) {
                const lastSlash = item.lastIndexOf('/');
                const parentPath = item.substring(0, lastSlash);
                addFolderAndParents(parentPath, foldersMap);
            }
        }

        // Step 3: For each root-level folder, recursively fetch subfolders
        const rootFolders = rootData.files
            .filter((item: string) => item.endsWith('/'))
            .map((item: string) => item.replace(/\/+$/, ''));

        for (const folderPath of rootFolders) {
            if (folderPath && !visitedPaths.has(folderPath)) {
                await crawlSubfolders(apiUrl, apiKey, folderPath, 1, visitedPaths, foldersMap);
            }
        }

        return Array.from(foldersMap.values()).sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
        console.error('[Obsidian API] Error fetching folders:', error);
        throw error;
    }
}

/**
 * Adds a folder path AND all its parent folders to the map.
 * e.g. "Maths/Chapter-1/Sub" adds "Maths", "Maths/Chapter-1", "Maths/Chapter-1/Sub"
 */
function addFolderAndParents(folderPath: string, foldersMap: Map<string, ObsidianFolder>): void {
    const parts = folderPath.split('/');
    let currentPath = '';
    for (const part of parts) {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (!foldersMap.has(currentPath)) {
            foldersMap.set(currentPath, { path: currentPath, name: currentPath });
        }
    }
}

/**
 * Crawls subfolders sequentially to avoid race conditions.
 */
async function crawlSubfolders(
    apiUrl: string,
    apiKey: string,
    folderPath: string,
    depth: number,
    visitedPaths: Set<string>,
    foldersMap: Map<string, ObsidianFolder>
): Promise<void> {
    if (depth > 15 || visitedPaths.has(folderPath)) {
        return;
    }
    visitedPaths.add(folderPath);

    const encodedPath = folderPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${apiUrl}${encodedPath}/`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.files)) return;

        for (const item of data.files) {
            if (typeof item !== 'string') continue;

            if (item.endsWith('/')) {
                const subName = item.replace(/\/+$/, '').replace(/^\/+/, '');
                const fullPath = subName.startsWith(folderPath + '/') ? subName : `${folderPath}/${subName}`;
                const cleanPath = fullPath.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');

                addFolderAndParents(cleanPath, foldersMap);

                if (cleanPath && !visitedPaths.has(cleanPath)) {
                    await crawlSubfolders(apiUrl, apiKey, cleanPath, depth + 1, visitedPaths, foldersMap);
                }
            } else if (item.includes('/')) {
                const fullItem = item.startsWith(folderPath + '/') ? item : `${folderPath}/${item}`;
                const lastSlash = fullItem.lastIndexOf('/');
                const parentPath = fullItem.substring(0, lastSlash);
                addFolderAndParents(parentPath, foldersMap);
            }
        }
    } catch (error) {
        // Silently skip folders that can't be listed
    }
}
