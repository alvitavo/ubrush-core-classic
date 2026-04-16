import { IBrush } from '../UBrushCore/common/IBrush';
import { SchemaFormRenderer } from './SchemaFormRenderer';

interface BrushSchemaSection {
    title: string;
    schema: any;
    uischema: any;
}

export class BrushEditorScreen {
    readonly element: HTMLElement;

    private tabButtons: HTMLButtonElement[] = [];
    private tabPanels: HTMLElement[] = [];
    private activeTab: number = 0;
    private currentBrush: IBrush | null = null;
    private schema: BrushSchemaSection[] = [];
    private renderer = new SchemaFormRenderer();
    private onBack: () => void;
    private onApply: (brush: IBrush) => void;
    private applyBtn!: HTMLButtonElement;

    constructor(onBack: () => void, onApply: (brush: IBrush) => void) {
        this.onBack = onBack;
        this.onApply = onApply;
        this.element = this.buildLayout();
    }

    async loadSchema(): Promise<void> {
        const resp = await fetch('brushSchema.json');
        const json = await resp.json();
        this.schema = json.data as BrushSchemaSection[];
        this.buildTabs();
    }

    loadBrush(brush: IBrush): void {
        // Deep-clone so edits don't immediately affect the drawing canvas
        this.currentBrush = JSON.parse(JSON.stringify(brush));
        this.renderActiveTab();
    }

    show(): void { this.element.style.display = 'flex'; }
    hide(): void { this.element.style.display = 'none'; }

    // ---- layout ----

    private buildLayout(): HTMLElement {
        const screen = document.createElement('div');
        screen.style.cssText = `
            display: none;
            flex-direction: column;
            width: 100vw;
            height: 100vh;
            background: #1e1e1e;
            font-family: sans-serif;
            overflow: hidden;
        `;

        screen.appendChild(this.buildHeader());

        const body = document.createElement('div');
        body.style.cssText = `display:flex; flex:1; overflow:hidden;`;

        const tabNav = document.createElement('div');
        tabNav.id = 'tab-nav';
        tabNav.style.cssText = `
            width: 150px;
            min-width: 150px;
            background: #252525;
            border-right: 1px solid #3a3a3a;
            display: flex;
            flex-direction: column;
            padding: 8px 0;
            overflow-y: auto;
        `;

        const tabContent = document.createElement('div');
        tabContent.id = 'tab-content';
        tabContent.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        `;

        body.appendChild(tabNav);
        body.appendChild(tabContent);
        screen.appendChild(body);

        this._tabNav = tabNav;
        this._tabContent = tabContent;

        return screen;
    }

    private _tabNav!: HTMLElement;
    private _tabContent!: HTMLElement;

    private buildHeader(): HTMLElement {
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 12px 20px;
            background: #252525;
            border-bottom: 1px solid #3a3a3a;
            flex-shrink: 0;
        `;

        const backBtn = btn('← Back to Drawing', '#3a3a3a', '#ccc');
        backBtn.addEventListener('click', () => this.onBack());
        header.appendChild(backBtn);

        const title = document.createElement('span');
        title.textContent = 'Brush Editor';
        title.style.cssText = `font-size:16px; font-weight:600; color:#e0e0e0; flex:1;`;
        header.appendChild(title);

        this.applyBtn = btn('Apply to Canvas', '#2a5aa0', '#fff');
        this.applyBtn.addEventListener('click', () => {
            if (this.currentBrush) this.onApply(this.currentBrush);
        });
        header.appendChild(this.applyBtn);

        return header;
    }

    private buildTabs(): void {
        this._tabNav.innerHTML = '';
        this._tabContent.innerHTML = '';
        this.tabButtons = [];
        this.tabPanels = [];

        this.schema.forEach((section, idx) => {
            // Tab button
            const tabBtn = document.createElement('button');
            tabBtn.textContent = section.title;
            tabBtn.style.cssText = `
                background: none;
                border: none;
                color: #999;
                text-align: left;
                padding: 10px 16px;
                font-size: 13px;
                cursor: pointer;
                border-left: 3px solid transparent;
                transition: all .15s;
                width: 100%;
            `;
            tabBtn.addEventListener('click', () => this.selectTab(idx));
            this._tabNav.appendChild(tabBtn);
            this.tabButtons.push(tabBtn);

            // Tab panel
            const panel = document.createElement('div');
            panel.style.display = 'none';
            this._tabContent.appendChild(panel);
            this.tabPanels.push(panel);
        });

        this.selectTab(0);
    }

    private selectTab(idx: number): void {
        this.activeTab = idx;

        this.tabButtons.forEach((btn, i) => {
            btn.style.color = i === idx ? '#fff' : '#999';
            btn.style.borderLeftColor = i === idx ? '#4a90d9' : 'transparent';
            btn.style.background = i === idx ? '#2a2a2a' : 'none';
        });

        this.tabPanels.forEach((panel, i) => {
            panel.style.display = i === idx ? 'block' : 'none';
        });

        this.renderActiveTab();
    }

    private renderActiveTab(): void {
        if (!this.currentBrush || this.schema.length === 0) return;

        const section = this.schema[this.activeTab];
        const panel = this.tabPanels[this.activeTab];
        if (!section || !panel) return;

        this.renderer.render(
            panel,
            section.schema,
            section.uischema,
            this.currentBrush,
            () => { /* data is mutated in place */ }
        );
    }
}

// ---- Helpers ----

function btn(text: string, bg: string, color: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `
        background: ${bg};
        color: ${color};
        border: 1px solid ${bg === '#3a3a3a' ? '#555' : bg};
        border-radius: 5px;
        padding: 8px 14px;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
    `;
    return b;
}
