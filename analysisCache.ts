import type { KataGoAnalysis } from './types';

const IDB_NAME = 'komi-analysis';
const IDB_VERSION = 1;
const IDB_STORE = 'analyses';

// --- Layer 1: In-Memory Cache (position hash -> KataGoAnalysis) ---

const memoryCache = new Map<string, KataGoAnalysis>();

/**
 * Generate a position hash from the move list.
 * Uses a simple string hash — sufficient for deduplication.
 */
export function positionHash(moves: string[]): string {
    const key = moves.join(',');
    // djb2 hash
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) & 0xffffffff;
    }
    return `pos_${hash.toString(36)}`;
}

/**
 * Generate a hash for an SGF string (for cross-session cache keys).
 */
export function sgfHash(sgfContent: string): string {
    let hash = 5381;
    for (let i = 0; i < sgfContent.length; i++) {
        hash = ((hash << 5) + hash + sgfContent.charCodeAt(i)) & 0xffffffff;
    }
    return `sgf_${hash.toString(36)}`;
}

/** Get analysis from in-memory cache */
export function getFromMemory(moves: string[]): KataGoAnalysis | undefined {
    return memoryCache.get(positionHash(moves));
}

/** Store analysis in in-memory cache */
export function setInMemory(moves: string[], analysis: KataGoAnalysis): void {
    memoryCache.set(positionHash(moves), analysis);
}

/** Clear in-memory cache */
export function clearMemoryCache(): void {
    memoryCache.clear();
}

/** Current in-memory cache size */
export function memoryCacheSize(): number {
    return memoryCache.size;
}

// --- Layer 2: IndexedDB (SGF hash -> full analysis results) ---

interface StoredGameAnalysis {
    sgfHash: string;
    analyzedAt: number;
    positions: Record<string, KataGoAnalysis>; // positionHash -> analysis
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB not available'));
            return;
        }

        const request = indexedDB.open(IDB_NAME, IDB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'sgfHash' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Load a full game analysis from IndexedDB.
 * Also populates the in-memory cache for fast access.
 */
export async function loadGameAnalysis(
    sgfKey: string
): Promise<Record<string, KataGoAnalysis> | null> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(sgfKey);

            request.onsuccess = () => {
                const result = request.result as StoredGameAnalysis | undefined;
                if (!result) {
                    resolve(null);
                    return;
                }

                // Populate memory cache
                for (const [hash, analysis] of Object.entries(result.positions)) {
                    memoryCache.set(hash, analysis);
                }

                resolve(result.positions);
            };

            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB load failed, using memory cache only:', e);
        return null;
    }
}

/**
 * Save a full game analysis to IndexedDB for cross-session persistence.
 */
export async function saveGameAnalysis(
    sgfKey: string,
    positions: Record<string, KataGoAnalysis>
): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);

            const entry: StoredGameAnalysis = {
                sgfHash: sgfKey,
                analyzedAt: Date.now(),
                positions,
            };

            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB save failed:', e);
    }
}

/**
 * Delete a game analysis from IndexedDB.
 */
export async function deleteGameAnalysis(sgfKey: string): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.delete(sgfKey);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB delete failed:', e);
    }
}

// --- Unified Cache Interface ---

/**
 * Get analysis for a position, checking memory first, then IndexedDB.
 * For IndexedDB lookups, requires the SGF hash to know which game to load.
 */
export async function getCachedAnalysis(
    moves: string[],
    sgfKey?: string
): Promise<KataGoAnalysis | null> {
    // Layer 1: memory
    const memResult = getFromMemory(moves);
    if (memResult) return memResult;

    // Layer 2: IndexedDB (if sgfKey provided)
    if (sgfKey) {
        const gameData = await loadGameAnalysis(sgfKey);
        if (gameData) {
            const hash = positionHash(moves);
            return gameData[hash] ?? null;
        }
    }

    return null;
}

/**
 * Store analysis result in memory cache.
 * Call saveGameAnalysis separately to persist to IndexedDB.
 */
export function cacheAnalysis(moves: string[], analysis: KataGoAnalysis): void {
    setInMemory(moves, analysis);
}
