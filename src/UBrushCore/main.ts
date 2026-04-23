import { App } from './App';

// Prevent pinch-zoom (multi-touch)
document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// Prevent double-tap zoom (skip interactive elements so buttons still work)
let lastTap = 0;
document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
        const target = e.target as Element;
        if (!target.closest('button, input, select, label, a')) {
            e.preventDefault();
        }
    }
    lastTap = now;
}, { passive: false });

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app')!;
    const app = new App();
    app.init(root);
});
