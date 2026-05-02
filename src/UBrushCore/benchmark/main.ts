import { UBrushContext } from '../gpu/UBrushContext';
import { Canvas } from '../canvas/Canvas';
import { Size } from '../common/Size';
import { Color } from '../common/Color';
import { IBrush } from '../common/IBrush';
import { ProgramManager } from '../program/ProgramManager';
import { CurveKind, sampleUniformSpacing } from './curves';
import { AnimationStyle, Mode, RunResult, runAnimation, runFrame, runThroughput } from './runner';

interface CategoryEntry { key: string; displayName: string; file: string; }
interface FavoriteEntry { name: string; file: string; }
interface FavoriteScore {
    name: string;
    file: string;
    scenarios: number;     // count of throughput scenarios that contributed
    totalFlushMs: number;  // sum of flushMs across throughput scenarios — lower is better
    avgPointsPerSec: number;
    error?: string;
}
interface FavoriteAnimScore {
    name: string;
    file: string;
    perStyleFps: Partial<Record<AnimationStyle, number>>;
    avgFps: number;
    error?: string;
}

const CURVES: CurveKind[] = ['line', 'sine', 'spiral'];
const SPACINGS: { label: string; px: number }[] = [
    { label: 'dense (2px)', px: 2 },
    { label: 'medium (10px)', px: 10 },
];
const MODES: Mode[] = ['throughput', 'frame', 'animate'];
const ANIMATION_STYLES: AnimationStyle[] = ['translate', 'scale', 'rotate'];
const DURATIONS: { label: string; sec: number }[] = [
    { label: '1s', sec: 1 },
    { label: '3s', sec: 3 },
    { label: '5s', sec: 5 },
];
const FAVORITES_ANIM_DURATION_SEC = 3;

class BenchmarkApp {
    private gl!: WebGL2RenderingContext;
    private context!: UBrushContext;
    private canvas!: Canvas;
    private canvasW = 0;
    private canvasH = 0;

    private categories: CategoryEntry[] = [];
    private brushesByFile = new Map<string, IBrush[]>();
    private currentBrush?: IBrush;

    private categorySel!: HTMLSelectElement;
    private brushSel!: HTMLSelectElement;
    private curveSel!: HTMLSelectElement;
    private spacingSel!: HTMLSelectElement;
    private modeSel!: HTMLSelectElement;
    private animSel!: HTMLSelectElement;
    private durSel!: HTMLSelectElement;
    private runBtn!: HTMLButtonElement;
    private runAllBtn!: HTMLButtonElement;
    private runFavBtn!: HTMLButtonElement;
    private runFavAnimBtn!: HTMLButtonElement;
    private clearBtn!: HTMLButtonElement;
    private copyBtn!: HTMLButtonElement;
    private statusEl!: HTMLElement;
    private resultsEl!: HTMLElement;

    private results: (RunResult & { scenario: string })[] = [];
    private favoriteScores: FavoriteScore[] = [];
    private favoriteAnimScores: FavoriteAnimScore[] = [];

    async init(): Promise<void> {
        this.buildSidebar();
        this.statusEl = document.getElementById('status')!;
        this.resultsEl = document.getElementById('results')!;
        this.renderResultsTable();

        this.initWebGL();
        await this.loadCategories();
        await this.applyCurrentBrush();
    }

    private initWebGL(): void {
        const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
        const wrap = glCanvas.parentElement!;
        const cssW = wrap.clientWidth;
        const cssH = wrap.clientHeight;
        this.canvasW = cssW * 2;
        this.canvasH = cssH * 2;
        glCanvas.width = this.canvasW;
        glCanvas.height = this.canvasH;

        const attribs: WebGLContextAttributes = {
            alpha: false, depth: false, stencil: false, antialias: true,
            premultipliedAlpha: true, preserveDrawingBuffer: true,
        };
        const gl = glCanvas.getContext('webgl2', attribs);
        if (!gl) throw new Error('WebGL2 not supported');
        this.gl = gl;

        this.context = new UBrushContext(gl, new Size(this.canvasW, this.canvasH));
        this.canvas = new Canvas(this.context, new Size(this.canvasW, this.canvasH));
        ProgramManager.init(this.context);

        this.canvas.setColor(new Color(0, 0, 0, 1));
        this.canvas.lineDriver.setBrushSize(0.1);
        this.canvas.lineDriver.setBrushOpacity(1.0);
    }

    private async loadCategories(): Promise<void> {
        const resp = await fetch('brushCategories.json');
        const manifest = await resp.json() as CategoryEntry[];
        this.categories = manifest;

        for (const cat of manifest) {
            const opt = document.createElement('option');
            opt.value = cat.file;
            opt.textContent = cat.displayName;
            this.categorySel.appendChild(opt);
        }

        if (manifest.length > 0) {
            await this.loadBrushesForCategory(manifest[0].file);
            this.categorySel.value = manifest[0].file;
            this.refreshBrushSelect();
        }
    }

    private async loadBrushesForCategory(file: string): Promise<void> {
        if (this.brushesByFile.has(file)) return;
        const resp = await fetch(file);
        const data = await resp.json() as IBrush[];
        this.brushesByFile.set(file, Array.isArray(data) ? data : []);
    }

    private refreshBrushSelect(): void {
        const file = this.categorySel.value;
        const brushes = this.brushesByFile.get(file) ?? [];
        this.brushSel.innerHTML = '';
        brushes.forEach((b, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = b.name ?? `Brush ${i + 1}`;
            this.brushSel.appendChild(opt);
        });
        if (brushes.length > 0) this.brushSel.value = '0';
    }

    private async applyCurrentBrush(): Promise<void> {
        const file = this.categorySel.value;
        const brushes = this.brushesByFile.get(file) ?? [];
        const idx = parseInt(this.brushSel.value || '0', 10);
        const brush = brushes[idx];
        if (!brush) return;
        this.currentBrush = JSON.parse(JSON.stringify(brush));
        await this.canvas.setBrush(this.currentBrush);
    }

    private buildSidebar(): void {
        const sidebar = document.getElementById('sidebar')!;
        sidebar.innerHTML = '';

        const h1 = document.createElement('h1');
        h1.textContent = 'UBrush Benchmark';
        sidebar.appendChild(h1);

        // Category
        sidebar.appendChild(labeled('Brush category', this.categorySel = makeSelect()));
        this.categorySel.addEventListener('change', async () => {
            await this.loadBrushesForCategory(this.categorySel.value);
            this.refreshBrushSelect();
            await this.applyCurrentBrush();
        });

        // Brush
        sidebar.appendChild(labeled('Brush', this.brushSel = makeSelect()));
        this.brushSel.addEventListener('change', async () => { await this.applyCurrentBrush(); });

        // Curve
        this.curveSel = makeSelect();
        for (const c of CURVES) {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            this.curveSel.appendChild(o);
        }
        sidebar.appendChild(labeled('Curve', this.curveSel));

        // Spacing
        this.spacingSel = makeSelect();
        for (const s of SPACINGS) {
            const o = document.createElement('option');
            o.value = String(s.px); o.textContent = s.label;
            this.spacingSel.appendChild(o);
        }
        sidebar.appendChild(labeled('Spacing', this.spacingSel));

        // Mode
        this.modeSel = makeSelect();
        for (const m of MODES) {
            const o = document.createElement('option');
            o.value = m; o.textContent = m;
            this.modeSel.appendChild(o);
        }
        sidebar.appendChild(labeled('Mode', this.modeSel));
        this.modeSel.addEventListener('change', () => this.refreshAnimEnable());

        // Animation style (active only when mode === 'animate')
        this.animSel = makeSelect();
        for (const s of ANIMATION_STYLES) {
            const o = document.createElement('option');
            o.value = s; o.textContent = s;
            this.animSel.appendChild(o);
        }
        sidebar.appendChild(labeled('Animation', this.animSel));

        // Duration (active only when mode === 'animate')
        this.durSel = makeSelect();
        for (const d of DURATIONS) {
            const o = document.createElement('option');
            o.value = String(d.sec); o.textContent = d.label;
            this.durSel.appendChild(o);
        }
        this.durSel.value = '3';
        sidebar.appendChild(labeled('Duration', this.durSel));

        this.refreshAnimEnable();

        // Buttons
        this.runBtn = makeButton('Run', false);
        this.runBtn.addEventListener('click', () => this.runOne());
        sidebar.appendChild(this.runBtn);

        this.runAllBtn = makeButton('Run All (12 scenarios)', false);
        this.runAllBtn.addEventListener('click', () => this.runAll());
        sidebar.appendChild(this.runAllBtn);

        this.runFavBtn = makeButton('Score Favorites', false);
        this.runFavBtn.addEventListener('click', () => this.runFavorites());
        sidebar.appendChild(this.runFavBtn);

        this.runFavAnimBtn = makeButton(`Score Favorites (Animation, ${FAVORITES_ANIM_DURATION_SEC}s)`, false);
        this.runFavAnimBtn.addEventListener('click', () => this.runFavoritesAnimation());
        sidebar.appendChild(this.runFavAnimBtn);

        this.clearBtn = makeButton('Clear canvas', true);
        this.clearBtn.addEventListener('click', () => { this.canvas?.clear(); });
        sidebar.appendChild(this.clearBtn);

        this.copyBtn = makeButton('Copy results JSON', true);
        this.copyBtn.addEventListener('click', () => this.copyResults());
        sidebar.appendChild(this.copyBtn);

        const note = document.createElement('div');
        note.style.cssText = 'color:#666; font-size:10px; line-height:1.5; margin-top:8px;';
        note.textContent = 'Throughput = synchronous moveTo→lineTo→endLine then gl.finish(). '
            + 'Frame = batched across rAF (4 points/frame), records frame-time histogram. '
            + 'Same brush state, deterministic input.';
        sidebar.appendChild(note);
    }

    private setStatus(text: string): void {
        this.statusEl.textContent = text;
    }

    private setBusy(busy: boolean): void {
        this.runBtn.disabled = busy;
        this.runAllBtn.disabled = busy;
        this.runFavBtn.disabled = busy;
        this.runFavAnimBtn.disabled = busy;
        this.categorySel.disabled = busy;
        this.brushSel.disabled = busy;
    }

    private refreshAnimEnable(): void {
        const isAnim = (this.modeSel.value as Mode) === 'animate';
        this.animSel.disabled = !isAnim;
        this.durSel.disabled = !isAnim;
    }

    private async runOne(): Promise<void> {
        this.setBusy(true);
        try {
            const curve = this.curveSel.value as CurveKind;
            const spacing = parseFloat(this.spacingSel.value);
            const mode = this.modeSel.value as Mode;
            const style = this.animSel.value as AnimationStyle;
            const durSec = parseFloat(this.durSel.value);
            await this.runScenario(curve, spacing, mode, style, durSec);
        } finally {
            this.setBusy(false);
            this.setStatus('');
        }
    }

    private async runAll(): Promise<void> {
        this.setBusy(true);
        this.results = [];
        try {
            for (const curve of CURVES) {
                for (const s of SPACINGS) {
                    for (const mode of MODES) {
                        // Skip animate in batch run — favorites button covers it
                        // and animate scenarios take O(seconds) each.
                        if (mode === 'animate') continue;
                        await this.runScenario(curve, s.px, mode);
                    }
                }
            }
        } finally {
            this.setBusy(false);
            this.setStatus('Done.');
        }
    }

    private async runFavorites(): Promise<void> {
        this.setBusy(true);
        this.favoriteScores = [];
        this.renderResultsTable();

        try {
            const favorites = await this.fetchFavorites();
            if (favorites.length === 0) {
                this.setStatus('No favorites found.');
                return;
            }

            for (let i = 0; i < favorites.length; i++) {
                const fav = favorites[i];
                this.setStatus(`Scoring ${i + 1}/${favorites.length}: ${fav.name}…`);
                const score = await this.scoreFavorite(fav, i + 1, favorites.length);
                this.favoriteScores.push(score);
                this.renderResultsTable();
            }

            const total = this.favoriteScores.reduce((s, f) => s + f.totalFlushMs, 0);
            this.setStatus(`Done. Total = ${(total / 1000).toFixed(2)}s across ${this.favoriteScores.length} favorites.`);
        } catch (e) {
            console.error(e);
            this.setStatus(`Favorites run failed: ${(e as Error).message}`);
        } finally {
            this.setBusy(false);
        }
    }

    private async fetchFavorites(): Promise<FavoriteEntry[]> {
        const resp = await fetch('favorites.json');
        if (!resp.ok) return [];
        const data = await resp.json() as any[];
        return data.map(e => ({ name: e.name, file: e.file }));
    }

    private async scoreFavorite(fav: FavoriteEntry, idx: number, total: number): Promise<FavoriteScore> {
        try {
            await this.loadBrushesForCategory(fav.file);
            const brushes = this.brushesByFile.get(fav.file) ?? [];
            const brush = brushes.find(b => b.name === fav.name);
            if (!brush) {
                return { name: fav.name, file: fav.file, scenarios: 0, totalFlushMs: 0, avgPointsPerSec: 0, error: 'not found' };
            }

            this.currentBrush = JSON.parse(JSON.stringify(brush));
            await this.canvas.setBrush(this.currentBrush);

            let totalFlushMs = 0;
            let scenariosRun = 0;
            let ptsSecSum = 0;

            for (const curve of CURVES) {
                for (const s of SPACINGS) {
                    this.setStatus(`Scoring ${idx}/${total}: ${fav.name} — ${curve}/${s.label}`);
                    this.canvas.clear();
                    this.gl.finish();
                    const points = sampleUniformSpacing(
                        { kind: curve, canvasWidth: this.canvasW, canvasHeight: this.canvasH },
                        s.px,
                    );
                    await new Promise<void>(r => requestAnimationFrame(() => r()));
                    const result = await runThroughput(this.canvas, this.context, this.gl, points);
                    totalFlushMs += result.flushMs;
                    ptsSecSum += result.pointsPerSec;
                    scenariosRun++;
                }
            }

            return {
                name: fav.name,
                file: fav.file,
                scenarios: scenariosRun,
                totalFlushMs,
                avgPointsPerSec: ptsSecSum / Math.max(1, scenariosRun),
            };
        } catch (e) {
            return {
                name: fav.name, file: fav.file, scenarios: 0, totalFlushMs: 0, avgPointsPerSec: 0,
                error: (e as Error).message,
            };
        }
    }

    private async runFavoritesAnimation(): Promise<void> {
        this.setBusy(true);
        this.favoriteAnimScores = [];
        this.renderResultsTable();

        try {
            const favorites = await this.fetchFavorites();
            if (favorites.length === 0) {
                this.setStatus('No favorites found.');
                return;
            }

            for (let i = 0; i < favorites.length; i++) {
                const fav = favorites[i];
                this.setStatus(`Animating ${i + 1}/${favorites.length}: ${fav.name}…`);
                const score = await this.scoreFavoriteAnimation(fav, i + 1, favorites.length);
                this.favoriteAnimScores.push(score);
                this.renderResultsTable();
            }

            const valid = this.favoriteAnimScores.filter(s => !s.error);
            const overall = valid.length === 0
                ? 0
                : valid.reduce((s, f) => s + f.avgFps, 0) / valid.length;
            this.setStatus(`Done. Overall avg FPS = ${overall.toFixed(1)} across ${valid.length} brushes.`);
        } catch (e) {
            console.error(e);
            this.setStatus(`Favorites animation run failed: ${(e as Error).message}`);
        } finally {
            this.setBusy(false);
        }
    }

    private async scoreFavoriteAnimation(
        fav: FavoriteEntry, idx: number, total: number,
    ): Promise<FavoriteAnimScore> {
        try {
            await this.loadBrushesForCategory(fav.file);
            const brushes = this.brushesByFile.get(fav.file) ?? [];
            const brush = brushes.find(b => b.name === fav.name);
            if (!brush) {
                return { name: fav.name, file: fav.file, perStyleFps: {}, avgFps: 0, error: 'not found' };
            }

            this.currentBrush = JSON.parse(JSON.stringify(brush));
            await this.canvas.setBrush(this.currentBrush);

            // Fixed scenario: spiral / 2px — peak load that exposes regressions.
            const points = sampleUniformSpacing(
                { kind: 'spiral', canvasWidth: this.canvasW, canvasHeight: this.canvasH },
                2,
            );

            const perStyleFps: Partial<Record<AnimationStyle, number>> = {};
            let fpsSum = 0;
            let stylesRun = 0;

            for (const style of ANIMATION_STYLES) {
                this.setStatus(`Animating ${idx}/${total}: ${fav.name} — ${style}`);
                this.canvas.clear();
                this.gl.finish();
                await new Promise<void>(r => requestAnimationFrame(() => r()));
                const result = await runAnimation(
                    this.canvas, this.context, this.gl, points,
                    style, FAVORITES_ANIM_DURATION_SEC, this.canvasW, this.canvasH,
                );
                const fps = result.avgFps ?? 0;
                perStyleFps[style] = fps;
                fpsSum += fps;
                stylesRun++;
            }

            return {
                name: fav.name,
                file: fav.file,
                perStyleFps,
                avgFps: stylesRun === 0 ? 0 : fpsSum / stylesRun,
            };
        } catch (e) {
            return {
                name: fav.name, file: fav.file, perStyleFps: {}, avgFps: 0,
                error: (e as Error).message,
            };
        }
    }

    private async runScenario(
        curve: CurveKind,
        spacingPx: number,
        mode: Mode,
        animStyle: AnimationStyle = 'translate',
        durSec: number = 3,
    ): Promise<void> {
        const label = mode === 'animate'
            ? `${curve} / ${spacingPx}px / animate-${animStyle}-${durSec}s`
            : `${curve} / ${spacingPx}px / ${mode}`;
        this.setStatus(`Running ${label}…`);

        // Reset canvas state between runs to keep measurements independent.
        this.canvas.clear();
        this.gl.finish();

        const points = sampleUniformSpacing(
            { kind: curve, canvasWidth: this.canvasW, canvasHeight: this.canvasH },
            spacingPx,
        );

        // Yield once so the UI status update paints before we block.
        await new Promise<void>(r => requestAnimationFrame(() => r()));

        const result = mode === 'throughput'
            ? await runThroughput(this.canvas, this.context, this.gl, points)
            : mode === 'frame'
                ? await runFrame(this.canvas, this.context, this.gl, points)
                : await runAnimation(
                    this.canvas, this.context, this.gl, points,
                    animStyle, durSec, this.canvasW, this.canvasH,
                );

        this.results.push({ ...result, scenario: label });
        this.renderResultsTable();
    }

    private renderResultsTable(): void {
        let html = this.renderFavoritesSummary();
        html += this.renderFavoritesAnimSummary();
        html += this.renderScenarioTable();
        this.resultsEl.innerHTML = html || '<div style="color:#555;text-align:center;padding:12px;">No runs yet.</div>';
    }

    private renderFavoritesSummary(): string {
        if (this.favoriteScores.length === 0) return '';
        const total = this.favoriteScores.reduce((s, f) => s + f.totalFlushMs, 0);
        const sorted = [...this.favoriteScores].sort((a, b) => b.totalFlushMs - a.totalFlushMs);

        let html = '<div style="margin-bottom:10px;">'
            + `<div style="color:#4a90d9;font-weight:600;margin-bottom:4px;">Favorites score — total ${(total / 1000).toFixed(2)}s `
            + `(sum of throughput flushMs across ${this.favoriteScores.length} brushes; lower is better)</div>`
            + '<table><thead><tr>'
            + '<th>brush</th><th>file</th><th>score (ms)</th><th>avg pts/sec</th><th>scenarios</th>'
            + '</tr></thead><tbody>';
        for (const f of sorted) {
            html += `<tr><td>${escapeHtml(f.name)}</td>`
                + `<td>${escapeHtml(f.file)}</td>`
                + `<td>${f.error ? `<span style="color:#c66">${escapeHtml(f.error)}</span>` : f.totalFlushMs.toFixed(1)}</td>`
                + `<td>${f.error ? '—' : Math.round(f.avgPointsPerSec).toLocaleString()}</td>`
                + `<td>${f.scenarios}</td></tr>`;
        }
        html += '</tbody></table></div>';
        return html;
    }

    private renderFavoritesAnimSummary(): string {
        if (this.favoriteAnimScores.length === 0) return '';
        const valid = this.favoriteAnimScores.filter(s => !s.error);
        const overallAvg = valid.length === 0
            ? 0
            : valid.reduce((s, f) => s + f.avgFps, 0) / valid.length;

        // Worst per-style fps across all valid brushes
        let worstFps = Infinity;
        let worstBrush = '';
        let worstStyle: AnimationStyle | '' = '';
        for (const f of valid) {
            for (const style of ANIMATION_STYLES) {
                const fps = f.perStyleFps[style];
                if (fps !== undefined && fps < worstFps) {
                    worstFps = fps;
                    worstBrush = f.name;
                    worstStyle = style;
                }
            }
        }
        const worstStr = worstFps === Infinity
            ? ''
            : ` (worst ${worstFps.toFixed(1)} on ${escapeHtml(worstBrush)}/${worstStyle})`;

        // Sort: slowest first (regression visibility); errors at the bottom.
        const sorted = [...this.favoriteAnimScores].sort((a, b) => {
            if (a.error && !b.error) return 1;
            if (!a.error && b.error) return -1;
            return a.avgFps - b.avgFps;
        });

        let html = '<div style="margin-bottom:10px;">'
            + `<div style="color:#4a90d9;font-weight:600;margin-bottom:4px;">`
            + `Favorites animation FPS — overall avg ${overallAvg.toFixed(1)}`
            + `${worstStr} (spiral / 2px / ${FAVORITES_ANIM_DURATION_SEC}s, ${valid.length} brushes; higher is better)`
            + `</div>`
            + '<table><thead><tr>'
            + '<th>brush</th><th>file</th>'
            + '<th>translate fps</th><th>scale fps</th><th>rotate fps</th>'
            + '<th>avg fps</th>'
            + '</tr></thead><tbody>';
        for (const f of sorted) {
            html += `<tr><td>${escapeHtml(f.name)}</td>`
                + `<td>${escapeHtml(f.file)}</td>`;
            if (f.error) {
                html += `<td colspan="4"><span style="color:#c66">${escapeHtml(f.error)}</span></td>`;
            } else {
                for (const style of ANIMATION_STYLES) {
                    const fps = f.perStyleFps[style];
                    html += `<td>${fps !== undefined ? fps.toFixed(1) : '—'}</td>`;
                }
                html += `<td><b>${f.avgFps.toFixed(1)}</b></td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }

    private renderScenarioTable(): string {
        const rows = this.results;
        if (rows.length === 0) return '';
        const hasFrame = rows.some(r => r.frameMs);
        const hasFps = rows.some(r => r.avgFps !== undefined);
        const hasHeap = rows.some(r => r.heapDeltaMb !== undefined);

        let html = '<div style="color:#4a90d9;font-weight:600;margin-bottom:4px;">Scenario detail</div>'
            + '<table><thead><tr>'
            + '<th>scenario</th><th>n</th><th>cpu (ms)</th><th>flush (ms)</th><th>pts/sec</th>';
        if (hasFps) html += '<th>fps</th><th>frames</th>';
        if (hasFrame) html += '<th>p50 (ms)</th><th>p95 (ms)</th><th>p99 (ms)</th><th>max (ms)</th>';
        if (hasHeap) html += '<th>Δheap (MB)</th>';
        html += '</tr></thead><tbody>';

        for (const r of rows) {
            html += `<tr><td>${escapeHtml(r.scenario)}</td>`
                + `<td>${r.n}</td>`
                + `<td>${r.cpuMs.toFixed(2)}</td>`
                + `<td>${r.flushMs.toFixed(2)}</td>`
                + `<td>${Math.round(r.pointsPerSec).toLocaleString()}</td>`;
            if (hasFps) {
                html += r.avgFps !== undefined
                    ? `<td>${r.avgFps.toFixed(1)}</td><td>${r.frames ?? 0}</td>`
                    : '<td>—</td><td>—</td>';
            }
            if (hasFrame) {
                if (r.frameMs) {
                    html += `<td>${r.frameMs.p50.toFixed(2)}</td>`
                        + `<td>${r.frameMs.p95.toFixed(2)}</td>`
                        + `<td>${r.frameMs.p99.toFixed(2)}</td>`
                        + `<td>${r.frameMs.max.toFixed(2)}</td>`;
                } else {
                    html += '<td>—</td><td>—</td><td>—</td><td>—</td>';
                }
            }
            if (hasHeap) {
                html += r.heapDeltaMb !== undefined
                    ? `<td>${r.heapDeltaMb.toFixed(2)}</td>` : '<td>—</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        return html;
    }

    private async copyResults(): Promise<void> {
        const favTotal = this.favoriteScores.reduce((s, f) => s + f.totalFlushMs, 0);
        const animValid = this.favoriteAnimScores.filter(s => !s.error);
        const animOverallFps = animValid.length === 0
            ? null
            : animValid.reduce((s, f) => s + f.avgFps, 0) / animValid.length;
        const payload = {
            timestamp: new Date().toISOString(),
            canvasSize: { width: this.canvasW, height: this.canvasH },
            brush: this.currentBrush?.name ?? null,
            favoritesTotalMs: this.favoriteScores.length > 0 ? favTotal : null,
            favoriteScores: this.favoriteScores,
            favoritesAnimOverallFps: animOverallFps,
            favoriteAnimScores: this.favoriteAnimScores,
            results: this.results,
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            this.setStatus('Copied results JSON to clipboard.');
        } catch (e) {
            this.setStatus('Clipboard unavailable; see console.');
            console.log(JSON.stringify(payload, null, 2));
        }
    }
}

function makeSelect(): HTMLSelectElement {
    return document.createElement('select');
}

function makeButton(text: string, secondary: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    if (secondary) b.classList.add('secondary');
    return b;
}

function labeled(text: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.textContent = text;
    wrap.appendChild(lbl);
    wrap.appendChild(control);
    return wrap;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[c]);
}

window.addEventListener('DOMContentLoaded', () => {
    new BenchmarkApp().init().catch((e) => {
        console.error(e);
        const status = document.getElementById('status');
        if (status) status.textContent = `Init failed: ${e?.message ?? e}`;
    });
});
