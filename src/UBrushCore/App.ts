import { IBrush } from '../UBrushCore/common/IBrush';
import { DrawingScreen } from './DrawingScreen';
import { BrushEditorScreen } from './BrushEditorScreen';
import { initFavorites } from './favorites/FavoritesManager';

export interface BrushCategory {
    key: string;
    displayName: string;
    file: string;
    brushes?: IBrush[];
}

export class App {
    private drawingScreen?: DrawingScreen;
    private editorScreen?: BrushEditorScreen;

    async init(container: HTMLElement): Promise<void> {
        const categories = await this.loadCategories();

        this.drawingScreen = new DrawingScreen(categories, () => this.showEditor());
        this.editorScreen = new BrushEditorScreen(
            () => this.showDrawing(),
            (brush) => this.applyBrushFromEditor(brush)
        );

        container.appendChild(this.drawingScreen.element);
        container.appendChild(this.editorScreen.element);

        this.editorScreen.loadSchema().catch(console.error);
        this.showDrawing();
    }

    private showDrawing(): void {
        this.editorScreen?.hide();
        this.drawingScreen?.refreshFavoritesCategory();
        this.drawingScreen?.show();
    }

    private showEditor(): void {
        const info = this.drawingScreen?.getCurrentBrushInfo();
        this.drawingScreen?.hide();
        this.editorScreen?.show();
        if (info) this.editorScreen?.loadBrush(info.brush, info.categoryFile);
    }

    private applyBrushFromEditor(brush: IBrush): void {
        this.drawingScreen?.applyBrush(brush);
        this.showDrawing();
    }

    private async loadCategories(): Promise<BrushCategory[]> {
        try {
            const resp = await fetch('brushCategories.json');
            const manifest: BrushCategory[] = await resp.json();

            const [firstBrushes, favEntries] = await Promise.all([
                manifest.length > 0 ? App.loadCategoryBrushes(manifest[0].file) : Promise.resolve([]),
                initFavorites(),
            ]);
            if (manifest.length > 0) manifest[0].brushes = firstBrushes;

            // Pre-load any category files referenced by favorites that aren't already loaded
            const firstFile = manifest[0]?.file;
            const extraFiles = [...new Set(
                favEntries.map(f => f.file).filter(f => f !== firstFile && f !== '__favorites__')
            )];
            const extraBrushArrays = await Promise.all(extraFiles.map(f => App.loadCategoryBrushes(f)));
            extraFiles.forEach((f, i) => {
                const cat = manifest.find(c => c.file === f);
                if (cat) cat.brushes = extraBrushArrays[i];
            });

            // Build a file→brushes lookup and resolve favorites to actual brush objects
            const brushMap = new Map<string, IBrush[]>();
            if (manifest.length > 0) brushMap.set(manifest[0].file, firstBrushes);
            extraFiles.forEach((f, i) => brushMap.set(f, extraBrushArrays[i]));

            const favBrushes: IBrush[] = [];
            for (const fav of favEntries) {
                const brush = (brushMap.get(fav.file) ?? []).find(b => b.name === fav.name);
                if (brush) favBrushes.push(JSON.parse(JSON.stringify(brush)));
            }

            const favCategory: BrushCategory = {
                key: '__favorites__',
                displayName: '⭐ 즐겨찾기',
                file: '__favorites__',
                brushes: favBrushes,
            };
            return [favCategory, ...manifest];
        } catch (e) {
            console.warn('Could not load brushCategories.json', e);
            return [];
        }
    }

    static async loadCategoryBrushes(file: string): Promise<IBrush[]> {
        try {
            const resp = await fetch(file);
            const data = await resp.json();
            return Array.isArray(data) ? data as IBrush[] : [];
        } catch (e) {
            console.warn(`Could not load ${file}`, e);
            return [];
        }
    }
}
