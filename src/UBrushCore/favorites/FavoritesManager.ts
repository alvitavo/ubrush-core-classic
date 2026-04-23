const LS_KEY = 'ubrush_favorites';

export interface FavoriteEntry {
    name: string;
    file: string;
}

/** Called once at startup. Returns {name, file}[] — no brush data stored. */
export async function initFavorites(): Promise<FavoriteEntry[]> {
    if (process.env.NODE_ENV !== 'production') {
        const entries = await fetchFavoritesFile();
        saveLocal(entries);
        return entries;
    }
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
        try { return JSON.parse(raw); } catch {}
    }
    const entries = await fetchFavoritesFile();
    saveLocal(entries);
    return entries;
}

async function fetchFavoritesFile(): Promise<FavoriteEntry[]> {
    try {
        const resp = await fetch('./favorites.json');
        if (!resp.ok) return [];
        const data = await resp.json();
        // Normalize: strip brush field if present (old format migration)
        return (data as any[]).map(e => ({ name: e.name, file: e.file }));
    } catch { return []; }
}

export function getFavoritesSync(): FavoriteEntry[] {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); } catch { return []; }
}

export function isFavorite(brushName: string, categoryFile: string): boolean {
    return getFavoritesSync().some(f => f.name === brushName && f.file === categoryFile);
}

export async function setFavorite(brushName: string, categoryFile: string, favorited: boolean): Promise<void> {
    const entries = getFavoritesSync().filter(f => !(f.name === brushName && f.file === categoryFile));
    if (favorited) entries.push({ name: brushName, file: categoryFile });
    saveLocal(entries);
    if (process.env.NODE_ENV !== 'production') {
        await postToServer(entries);
    }
}

function saveLocal(entries: FavoriteEntry[]): void {
    try { localStorage.setItem(LS_KEY, JSON.stringify(entries)); } catch {}
}

async function postToServer(entries: FavoriteEntry[]): Promise<void> {
    await fetch('/api/save-favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entries),
    });
}
