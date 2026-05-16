import { Canvas } from '../canvas/Canvas';
import { Color } from '../common/Color';
import { IBrush } from '../common/IBrush';
import { Size } from '../common/Size';
import { Stylus } from '../common/Stylus';
import { WGPUContext } from '../gpu/webgpu/WGPUContext';
import { bootstrapWebGPU } from '../gpu/webgpu/bootstrap';
import { WGPUProgramManager } from '../program/webgpu/WGPUProgramManager';
import { CurveKind, sampleUniformSpacing } from './curves';

interface CategoryEntry { key: string; displayName: string; file: string; }

type StrokeMode = 'realtime' | 'batched';
type SuiteKind = 'quick' | 'full' | 'stress';

interface StrokeCase {
    id: string;
    curve: CurveKind;
    spacingPx: number;
    mode: StrokeMode;
}

interface StrokeMeasurement {
    caseId: string;
    brushName: string;
    brushFile: string;
    mode: StrokeMode;
    curve: CurveKind;
    spacingPx: number;
    points: number;
    iteration: number;
    totalMs: number;
    lineToMs: number;
    lineToAvgMs: number;
    lineToP95Ms: number;
    lineToMaxMs: number;
    endLineMs: number;
    gpuWaitMs: number;
    pointsPerSec: number;
    drawCalls?: number;
    heapDeltaMb?: number;
}

interface CaseSummary {
    caseId: string;
    brushName: string;
    mode: StrokeMode;
    curve: CurveKind;
    spacingPx: number;
    points: number;
    runs: number;
    totalAvgMs: number;
    totalP95Ms: number;
    lineToAvgMs: number;
    lineToP95Ms: number;
    lineToMaxMs: number;
    endLineAvgMs: number;
    gpuWaitAvgMs: number;
    pointsPerSecAvg: number;
    drawCallsAvg?: number;
    heapDeltaAvgMb?: number;
    score: number;
}

const CASES: Record<SuiteKind, StrokeCase[]> = {
    quick: [
        { id: 'line-6-realtime', curve: 'line', spacingPx: 6, mode: 'realtime' },
        { id: 'sine-6-realtime', curve: 'sine', spacingPx: 6, mode: 'realtime' },
        { id: 'sine-6-batched', curve: 'sine', spacingPx: 6, mode: 'batched' },
    ],
    full: [
        { id: 'line-2-realtime', curve: 'line', spacingPx: 2, mode: 'realtime' },
        { id: 'line-6-realtime', curve: 'line', spacingPx: 6, mode: 'realtime' },
        { id: 'sine-2-realtime', curve: 'sine', spacingPx: 2, mode: 'realtime' },
        { id: 'sine-6-realtime', curve: 'sine', spacingPx: 6, mode: 'realtime' },
        { id: 'spiral-4-realtime', curve: 'spiral', spacingPx: 4, mode: 'realtime' },
        { id: 'sine-2-batched', curve: 'sine', spacingPx: 2, mode: 'batched' },
        { id: 'spiral-4-batched', curve: 'spiral', spacingPx: 4, mode: 'batched' },
    ],
    stress: [
        { id: 'line-1-realtime', curve: 'line', spacingPx: 1, mode: 'realtime' },
        { id: 'sine-1-realtime', curve: 'sine', spacingPx: 1, mode: 'realtime' },
        { id: 'spiral-2-realtime', curve: 'spiral', spacingPx: 2, mode: 'realtime' },
        { id: 'line-1-batched', curve: 'line', spacingPx: 1, mode: 'batched' },
        { id: 'sine-1-batched', curve: 'sine', spacingPx: 1, mode: 'batched' },
        { id: 'spiral-2-batched', curve: 'spiral', spacingPx: 2, mode: 'batched' },
    ],
};

let drawCallCounter: { count: number } | null = null;
let drawCounterInstalled = false;

function installDrawCallCounter(): void {
    if (drawCounterInstalled) return;
    drawCounterInstalled = true;
    drawCallCounter = { count: 0 };
    const counter = drawCallCounter;
    const proto = (globalThis as any).GPURenderPassEncoder?.prototype;
    if (!proto) return;

    for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
        const orig = proto[method];
        if (typeof orig !== 'function') continue;
        proto[method] = function (...args: unknown[]) {
            counter.count++;
            return orig.apply(this, args);
        };
    }
}

function resetDrawCalls(): void {
    if (drawCallCounter) drawCallCounter.count = 0;
}

function getDrawCalls(): number | undefined {
    return drawCallCounter?.count;
}

function heapMb(): number | undefined {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / (1024 * 1024) : undefined;
}

function avg(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[index];
}

function max(values: number[]): number {
    return values.length === 0 ? 0 : Math.max(...values);
}

function componentScore(value: number, budget: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    if (budget <= 0) return 0;
    return 100 * Math.exp(-0.35 * (value / budget));
}

function performanceScore(summary: Omit<CaseSummary, 'score'>): number {
    const realtime = summary.mode === 'realtime';
    const budgets = realtime
        ? { lineP95: 2, lineMax: 16, totalPerPoint: 2, gpuWait: 16, drawsPerK: 1000 }
        : { lineP95: 0.15, lineMax: 1.5, totalPerPoint: 0.12, gpuWait: 8, drawsPerK: 160 };
    const totalPerPoint = summary.totalAvgMs / Math.max(1, summary.points);
    const drawsPerK = summary.drawCallsAvg === undefined
        ? 0
        : (summary.drawCallsAvg / Math.max(1, summary.points)) * 1000;

    const score =
        componentScore(summary.lineToP95Ms, budgets.lineP95) * 0.35 +
        componentScore(summary.lineToMaxMs, budgets.lineMax) * 0.2 +
        componentScore(totalPerPoint, budgets.totalPerPoint) * 0.2 +
        componentScore(summary.gpuWaitAvgMs, budgets.gpuWait) * 0.15 +
        componentScore(drawsPerK, budgets.drawsPerK) * 0.1;
    return Math.max(0, Math.min(100, score));
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[c] ?? c));
}

class DrawingBenchmarkLab {
    private context!: WGPUContext;
    private canvas!: Canvas;
    private canvasW = 0;
    private canvasH = 0;

    private categories: CategoryEntry[] = [];
    private brushesByFile = new Map<string, IBrush[]>();

    private categorySel!: HTMLSelectElement;
    private brushSel!: HTMLSelectElement;
    private suiteSel!: HTMLSelectElement;
    private iterationsInput!: HTMLInputElement;
    private warmupInput!: HTMLInputElement;
    private runBtn!: HTMLButtonElement;
    private runAllBtn!: HTMLButtonElement;
    private clearBtn!: HTMLButtonElement;
    private copyBtn!: HTMLButtonElement;
    private statusEl!: HTMLElement;
    private diagnosticsEl!: HTMLElement;
    private resultsEl!: HTMLElement;

    private measurements: StrokeMeasurement[] = [];

    async init(): Promise<void> {
        this.bindElements();
        this.buildControls();
        this.setStatus('Initializing WebGPU...');
        await this.initWebGPU();
        await this.loadCategories();
        await this.applySelectedBrush();
        this.render();
        this.setStatus('Ready.');
    }

    private bindElements(): void {
        this.statusEl = document.getElementById('status')!;
        this.diagnosticsEl = document.getElementById('diagnostics')!;
        this.resultsEl = document.getElementById('results')!;
    }

    private buildControls(): void {
        const sidebar = document.getElementById('sidebar')!;
        sidebar.innerHTML = '';

        const title = document.createElement('h1');
        title.textContent = 'Drawing Engine Lab';
        sidebar.appendChild(title);

        this.categorySel = makeSelect();
        sidebar.appendChild(labeled('Category', this.categorySel));
        this.categorySel.addEventListener('change', async () => {
            await this.loadBrushesForCategory(this.categorySel.value);
            this.refreshBrushes();
            await this.applySelectedBrush();
        });

        this.brushSel = makeSelect();
        sidebar.appendChild(labeled('Brush', this.brushSel));
        this.brushSel.addEventListener('change', async () => this.applySelectedBrush());

        this.suiteSel = makeSelect();
        for (const suite of ['quick', 'full', 'stress'] as SuiteKind[]) {
            const option = document.createElement('option');
            option.value = suite;
            option.textContent = suite;
            this.suiteSel.appendChild(option);
        }
        sidebar.appendChild(labeled('Suite', this.suiteSel));

        this.iterationsInput = makeInput('number', '5');
        this.iterationsInput.min = '1';
        this.iterationsInput.max = '50';
        sidebar.appendChild(labeled('Measured runs', this.iterationsInput));

        this.warmupInput = makeInput('number', '1');
        this.warmupInput.min = '0';
        this.warmupInput.max = '10';
        sidebar.appendChild(labeled('Warmup runs', this.warmupInput));

        this.runBtn = makeButton('Run Selected Brush', false);
        this.runBtn.addEventListener('click', () => void this.runSelectedBrush());
        sidebar.appendChild(this.runBtn);

        this.runAllBtn = makeButton('Run All Brushes In Category', false);
        this.runAllBtn.addEventListener('click', () => void this.runAllBrushesInCategory());
        sidebar.appendChild(this.runAllBtn);

        this.clearBtn = makeButton('Clear Results', true);
        this.clearBtn.addEventListener('click', () => {
            this.measurements = [];
            this.canvas?.clear();
            this.render();
        });
        sidebar.appendChild(this.clearBtn);

        this.copyBtn = makeButton('Copy JSON', true);
        this.copyBtn.addEventListener('click', () => void navigator.clipboard.writeText(JSON.stringify(this.exportPayload(), null, 2)));
        sidebar.appendChild(this.copyBtn);

        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Realtime measures per-event flush behavior. Batched measures pure stroke throughput. Each case clears the canvas and waits for GPU completion.';
        sidebar.appendChild(note);
    }

    private async initWebGPU(): Promise<void> {
        const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
        const wrap = glCanvas.parentElement!;
        const cssW = wrap.clientWidth;
        const cssH = wrap.clientHeight;
        this.canvasW = Math.max(1, Math.floor(cssW * 2));
        this.canvasH = Math.max(1, Math.floor(cssH * 2));
        glCanvas.width = this.canvasW;
        glCanvas.height = this.canvasH;

        installDrawCallCounter();
        const bootstrap = await bootstrapWebGPU(glCanvas);
        const size = new Size(this.canvasW, this.canvasH);
        this.context = new WGPUContext(bootstrap.device, bootstrap.presentationContext, bootstrap.presentationFormat, size);
        this.canvas = new Canvas(this.context, size);
        WGPUProgramManager.init(this.context);

        this.canvas.setColor(new Color(0, 0, 0, 1));
        this.canvas.lineDriver.setBrushSize(0.1);
        this.canvas.lineDriver.setBrushOpacity(1);

        const adapterInfo = (bootstrap.adapter as unknown as { info?: Record<string, unknown> }).info;
        this.diagnosticsEl.textContent = [
            `secure: ${window.isSecureContext ? 'yes' : 'no'}`,
            `format: ${bootstrap.presentationFormat}`,
            `vendor: ${adapterInfo?.vendor ?? '-'}`,
            `arch: ${adapterInfo?.architecture ?? '-'}`,
            `device: ${adapterInfo?.device ?? '-'}`,
            `maxTexture2D: ${bootstrap.device.limits.maxTextureDimension2D}`,
            `maxStorageBuffer: ${bootstrap.device.limits.maxStorageBufferBindingSize}`,
            `ua: ${navigator.userAgent}`,
        ].join('\n');
    }

    private async loadCategories(): Promise<void> {
        const resp = await fetch('brushCategories.json');
        this.categories = await resp.json() as CategoryEntry[];
        this.categorySel.innerHTML = '';
        for (const category of this.categories) {
            const option = document.createElement('option');
            option.value = category.file;
            option.textContent = category.displayName;
            this.categorySel.appendChild(option);
        }

        if (this.categories.length > 0) {
            this.categorySel.value = this.categories[0].file;
            await this.loadBrushesForCategory(this.categorySel.value);
            this.refreshBrushes();
        }
    }

    private async loadBrushesForCategory(file: string): Promise<void> {
        if (this.brushesByFile.has(file)) return;
        const resp = await fetch(file);
        const data = await resp.json() as IBrush[];
        this.brushesByFile.set(file, Array.isArray(data) ? data : []);
    }

    private refreshBrushes(): void {
        const brushes = this.brushesByFile.get(this.categorySel.value) ?? [];
        this.brushSel.innerHTML = '';
        brushes.forEach((brush, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = brush.name ?? `Brush ${index + 1}`;
            this.brushSel.appendChild(option);
        });
        this.brushSel.value = '0';
    }

    private async applySelectedBrush(): Promise<void> {
        const brush = this.selectedBrush();
        if (!brush) return;
        await this.canvas.setBrush(JSON.parse(JSON.stringify(brush)));
    }

    private selectedBrush(): IBrush | undefined {
        const brushes = this.brushesByFile.get(this.categorySel.value) ?? [];
        return brushes[Number(this.brushSel.value || 0)];
    }

    private selectedBrushesInCategory(): IBrush[] {
        return this.brushesByFile.get(this.categorySel.value) ?? [];
    }

    private selectedSuite(): SuiteKind {
        return this.suiteSel.value as SuiteKind;
    }

    private iterations(): number {
        return Math.max(1, Math.min(50, Number(this.iterationsInput.value || 1)));
    }

    private warmups(): number {
        return Math.max(0, Math.min(10, Number(this.warmupInput.value || 0)));
    }

    private async runSelectedBrush(): Promise<void> {
        const brush = this.selectedBrush();
        if (!brush) return;
        await this.runBrush(brush, this.categorySel.value);
    }

    private async runAllBrushesInCategory(): Promise<void> {
        const file = this.categorySel.value;
        const brushes = this.selectedBrushesInCategory();
        this.setBusy(true);
        try {
            for (let i = 0; i < brushes.length; i++) {
                this.brushSel.value = String(i);
                await this.runBrush(brushes[i], file, `${i + 1}/${brushes.length}`, false);
            }
        } finally {
            this.setBusy(false);
            this.setStatus('Done.');
        }
    }

    private async runBrush(brush: IBrush, file: string, prefix: string = '1/1', manageBusy: boolean = true): Promise<void> {
        if (manageBusy) this.setBusy(true);
        try {
            await this.canvas.setBrush(JSON.parse(JSON.stringify(brush)));
            const cases = CASES[this.selectedSuite()];
            const warmups = this.warmups();
            const runs = this.iterations();

            for (const testCase of cases) {
                for (let i = 0; i < warmups; i++) {
                    this.setStatus(`Warmup ${prefix}: ${brush.name} / ${testCase.id} (${i + 1}/${warmups})`);
                    await this.measureStrokeCase(brush, file, testCase, -1);
                }
                for (let i = 0; i < runs; i++) {
                    this.setStatus(`Run ${prefix}: ${brush.name} / ${testCase.id} (${i + 1}/${runs})`);
                    const measurement = await this.measureStrokeCase(brush, file, testCase, i + 1);
                    this.measurements.push(measurement);
                    this.render();
                }
            }
        } finally {
            if (manageBusy) {
                this.setBusy(false);
                this.setStatus('Ready.');
            }
        }
    }

    private async measureStrokeCase(brush: IBrush, file: string, testCase: StrokeCase, iteration: number): Promise<StrokeMeasurement> {
        this.canvas.clear();
        await this.context.device.queue.onSubmittedWorkDone();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const points = sampleUniformSpacing({
            kind: testCase.curve,
            canvasWidth: this.canvasW,
            canvasHeight: this.canvasH,
        }, testCase.spacingPx);
        const stylus = new Stylus(1, Math.PI / 2, 0);
        const lineTimes: number[] = [];
        const heapBefore = heapMb();

        resetDrawCalls();
        this.canvas.setStrokeBatchingEnabled(testCase.mode === 'batched');

        try {
            const start = performance.now();
            this.canvas.moveTo(points[0], stylus);
            for (let i = 1; i < points.length - 1; i++) {
                const t0 = performance.now();
                this.canvas.lineTo(points[i], stylus);
                lineTimes.push(performance.now() - t0);
            }
            const endStart = performance.now();
            await this.canvas.endLine(points[points.length - 1], stylus);
            const endLineMs = performance.now() - endStart;
            const gpuStart = performance.now();
            await this.context.device.queue.onSubmittedWorkDone();
            const gpuWaitMs = performance.now() - gpuStart;
            const totalMs = performance.now() - start;
            const heapAfter = heapMb();

            return {
                caseId: testCase.id,
                brushName: brush.name ?? 'Untitled',
                brushFile: file,
                mode: testCase.mode,
                curve: testCase.curve,
                spacingPx: testCase.spacingPx,
                points: points.length,
                iteration,
                totalMs,
                lineToMs: lineTimes.reduce((s, v) => s + v, 0),
                lineToAvgMs: avg(lineTimes),
                lineToP95Ms: quantile(lineTimes, 0.95),
                lineToMaxMs: max(lineTimes),
                endLineMs,
                gpuWaitMs,
                pointsPerSec: points.length / (totalMs / 1000),
                drawCalls: getDrawCalls(),
                heapDeltaMb: heapBefore !== undefined && heapAfter !== undefined ? heapAfter - heapBefore : undefined,
            };
        } finally {
            this.canvas.setStrokeBatchingEnabled(false);
        }
    }

    private summaries(): CaseSummary[] {
        const groups = new Map<string, StrokeMeasurement[]>();
        for (const measurement of this.measurements) {
            const key = `${measurement.brushFile}|${measurement.brushName}|${measurement.caseId}`;
            const group = groups.get(key) ?? [];
            group.push(measurement);
            groups.set(key, group);
        }

        return Array.from(groups.values()).map((group) => {
            const first = group[0];
            const drawCalls = group.map((m) => m.drawCalls).filter((v): v is number => v !== undefined);
            const heapDeltas = group.map((m) => m.heapDeltaMb).filter((v): v is number => v !== undefined);
            const summary = {
                caseId: first.caseId,
                brushName: first.brushName,
                mode: first.mode,
                curve: first.curve,
                spacingPx: first.spacingPx,
                points: first.points,
                runs: group.length,
                totalAvgMs: avg(group.map((m) => m.totalMs)),
                totalP95Ms: quantile(group.map((m) => m.totalMs), 0.95),
                lineToAvgMs: avg(group.map((m) => m.lineToAvgMs)),
                lineToP95Ms: avg(group.map((m) => m.lineToP95Ms)),
                lineToMaxMs: max(group.map((m) => m.lineToMaxMs)),
                endLineAvgMs: avg(group.map((m) => m.endLineMs)),
                gpuWaitAvgMs: avg(group.map((m) => m.gpuWaitMs)),
                pointsPerSecAvg: avg(group.map((m) => m.pointsPerSec)),
                drawCallsAvg: drawCalls.length > 0 ? avg(drawCalls) : undefined,
                heapDeltaAvgMb: heapDeltas.length > 0 ? avg(heapDeltas) : undefined,
            };
            return { ...summary, score: performanceScore(summary) };
        }).sort((a, b) => a.score - b.score);
    }

    private render(): void {
        const summaries = this.summaries();
        if (summaries.length === 0) {
            this.resultsEl.innerHTML = '<div class="empty">No measurements yet.</div>';
            return;
        }

        const scores = this.brushScores(summaries).map((s) => `
            <tr>
                <td>${escapeHtml(s.brushName)}</td>
                <td>${s.score.toFixed(1)}</td>
                <td>${s.cases}</td>
                <td>${escapeHtml(s.worstCase)}</td>
            </tr>
        `).join('');
        const rows = summaries.map((s) => `
            <tr>
                <td>${escapeHtml(s.brushName)}</td>
                <td>${escapeHtml(s.caseId)}</td>
                <td>${s.score.toFixed(1)}</td>
                <td>${s.mode}</td>
                <td>${s.points}</td>
                <td>${s.runs}</td>
                <td>${s.totalAvgMs.toFixed(1)}</td>
                <td>${s.totalP95Ms.toFixed(1)}</td>
                <td>${s.lineToAvgMs.toFixed(3)}</td>
                <td>${s.lineToP95Ms.toFixed(3)}</td>
                <td>${s.lineToMaxMs.toFixed(3)}</td>
                <td>${s.endLineAvgMs.toFixed(1)}</td>
                <td>${s.gpuWaitAvgMs.toFixed(1)}</td>
                <td>${Math.round(s.pointsPerSecAvg).toLocaleString()}</td>
                <td>${s.drawCallsAvg === undefined ? '-' : s.drawCallsAvg.toFixed(1)}</td>
                <td>${s.heapDeltaAvgMb === undefined ? '-' : s.heapDeltaAvgMb.toFixed(2)}</td>
            </tr>
        `).join('');

        this.resultsEl.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>brush</th>
                        <th>score</th>
                        <th>cases</th>
                        <th>worst case</th>
                    </tr>
                </thead>
                <tbody>${scores}</tbody>
            </table>
            <div style="height:12px"></div>
            <table>
                <thead>
                    <tr>
                        <th>brush</th>
                        <th>case</th>
                        <th>score</th>
                        <th>mode</th>
                        <th>pts</th>
                        <th>runs</th>
                        <th>total avg</th>
                        <th>total p95</th>
                        <th>line avg</th>
                        <th>line p95</th>
                        <th>line max</th>
                        <th>endLine</th>
                        <th>gpu wait</th>
                        <th>pts/sec</th>
                        <th>draws</th>
                        <th>heap MB</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    private brushScores(summaries: CaseSummary[]): { brushName: string; score: number; cases: number; worstCase: string }[] {
        const groups = new Map<string, CaseSummary[]>();
        for (const summary of summaries) {
            const group = groups.get(summary.brushName) ?? [];
            group.push(summary);
            groups.set(summary.brushName, group);
        }
        return Array.from(groups.entries()).map(([brushName, group]) => {
            const worst = [...group].sort((a, b) => a.score - b.score)[0];
            return {
                brushName,
                score: avg(group.map((s) => s.score)),
                cases: group.length,
                worstCase: worst?.caseId ?? '-',
            };
        }).sort((a, b) => a.score - b.score);
    }

    private exportPayload(): unknown {
        const summaries = this.summaries();
        return {
            generatedAt: new Date().toISOString(),
            canvas: { width: this.canvasW, height: this.canvasH },
            suite: this.selectedSuite(),
            brushScores: this.brushScores(summaries),
            summaries,
            measurements: this.measurements,
        };
    }

    private setStatus(text: string): void {
        this.statusEl.textContent = text;
    }

    private setBusy(busy: boolean): void {
        this.runBtn.disabled = busy;
        this.runAllBtn.disabled = busy;
        this.categorySel.disabled = busy;
        this.brushSel.disabled = busy;
        this.suiteSel.disabled = busy;
        this.iterationsInput.disabled = busy;
        this.warmupInput.disabled = busy;
    }
}

function makeSelect(): HTMLSelectElement {
    return document.createElement('select');
}

function makeInput(type: string, value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    return input;
}

function makeButton(text: string, secondary: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = text;
    if (secondary) button.className = 'secondary';
    return button;
}

function labeled(labelText: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
}

window.addEventListener('DOMContentLoaded', () => {
    new DrawingBenchmarkLab().init().catch((error) => {
        console.error(error);
        const status = document.getElementById('status');
        if (status) status.textContent = `Benchmark init failed: ${error instanceof Error ? error.message : String(error)}`;
    });
});
