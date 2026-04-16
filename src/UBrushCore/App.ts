import { IBrush } from '../UBrushCore/common/IBrush';
import { DrawingScreen } from './DrawingScreen';
import { BrushEditorScreen } from './BrushEditorScreen';

export class App {
    private drawingScreen?: DrawingScreen;
    private editorScreen?: BrushEditorScreen;
    private container!: HTMLElement;

    async init(container: HTMLElement): Promise<void> {
        this.container = container;

        const brushes = await this.loadBrushes();

        this.drawingScreen = new DrawingScreen(brushes, () => this.showEditor());
        this.editorScreen = new BrushEditorScreen(
            () => this.showDrawing(),
            (brush) => this.applyBrushFromEditor(brush)
        );

        container.appendChild(this.drawingScreen.element);
        container.appendChild(this.editorScreen.element);

        // Load the brush editor schema (async, non-blocking)
        this.editorScreen.loadSchema().catch(console.error);

        // Start on drawing screen
        this.showDrawing();
    }

    private showDrawing(): void {
        this.editorScreen?.hide();
        this.drawingScreen?.show();
    }

    private showEditor(): void {
        const brush = this.drawingScreen?.getCurrentBrush();
        if (brush) this.editorScreen?.loadBrush(brush);
        this.drawingScreen?.hide();
        this.editorScreen?.show();
    }

    private applyBrushFromEditor(brush: IBrush): void {
        this.drawingScreen?.applyBrush(brush);
        this.showDrawing();
    }

    private async loadBrushes(): Promise<IBrush[]> {
        try {
            const resp = await fetch('brushes.json');
            const data = await resp.json();
            // brushes.json is a JSON array
            return Array.isArray(data) ? data as IBrush[] : [];
        } catch (e) {
            console.warn('Could not load brushes.json', e);
            return [];
        }
    }
}
