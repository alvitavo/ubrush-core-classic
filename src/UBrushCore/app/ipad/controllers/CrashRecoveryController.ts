import { DocumentController, DocumentSnapshot } from './DocumentController';

const DB_NAME = 'ubrush-ipad-recovery';
const DB_VERSION = 1;
const STORE_NAME = 'checkpoints';
const CHECKPOINT_KEY = 'active-document';
const SAVE_DELAY_MS = 1200;

interface StoredCheckpoint {
    id: string;
    snapshot: DocumentSnapshot;
}

export class CrashRecoveryController {
    private document?: DocumentController;
    private dbPromise?: Promise<IDBDatabase>;
    private saveTimer: number | null = null;
    private saveInFlight = false;
    private saveQueued = false;
    private readonly onDocumentChanged = () => this.scheduleSave();
    private readonly onPageHidden = () => {
        if (document.visibilityState === 'hidden') void this.saveNow();
    };

    public attach(documentController: DocumentController): void {
        this.detach();
        this.document = documentController;
        documentController.addChangeListener(this.onDocumentChanged);
        document.addEventListener('visibilitychange', this.onPageHidden);
        this.scheduleSave();
    }

    public detach(): void {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.document?.removeChangeListener(this.onDocumentChanged);
        document.removeEventListener('visibilitychange', this.onPageHidden);
        this.document = undefined;
    }

    public async loadLatest(): Promise<DocumentSnapshot | null> {
        try {
            const db = await this.openDb();
            const record = await this.getCheckpoint(db);
            return record?.snapshot ?? null;
        } catch (error) {
            console.warn('Crash recovery load failed', error);
            return null;
        }
    }

    public scheduleSave(): void {
        if (!this.document) return;
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveNow();
        }, SAVE_DELAY_MS);
    }

    public async saveNow(): Promise<void> {
        const documentController = this.document;
        if (!documentController) return;

        if (this.saveInFlight) {
            this.saveQueued = true;
            return;
        }

        this.saveInFlight = true;
        try {
            const snapshot = await documentController.createSnapshot();
            const db = await this.openDb();
            await this.putCheckpoint(db, {
                id: CHECKPOINT_KEY,
                snapshot
            });
        } catch (error) {
            console.warn('Crash recovery save failed', error);
        } finally {
            this.saveInFlight = false;
            if (this.saveQueued) {
                this.saveQueued = false;
                this.scheduleSave();
            }
        }
    }

    private openDb(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;

        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return this.dbPromise;
    }

    private getCheckpoint(db: IDBDatabase): Promise<StoredCheckpoint | undefined> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(CHECKPOINT_KEY);
            request.onsuccess = () => resolve(request.result as StoredCheckpoint | undefined);
            request.onerror = () => reject(request.error);
        });
    }

    private putCheckpoint(db: IDBDatabase, checkpoint: StoredCheckpoint): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(checkpoint);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}
