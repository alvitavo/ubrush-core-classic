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
    if (process.env.NODE_ENV === 'production') {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(console.error);
        });
    } else {
        // Dev: 이전에 설치된 SW가 fetch를 가로채면서 일부 Chromium 환경에서
        // navigator.gpu 노출이 막히는 케이스가 있어, 등록된 SW와 캐시를 모두 정리.
        navigator.serviceWorker.getRegistrations()
            .then(regs => Promise.all(regs.map(r => r.unregister())))
            .catch(() => {});
        if ('caches' in window) {
            caches.keys()
                .then(keys => Promise.all(keys.map(k => caches.delete(k))))
                .catch(() => {});
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app')!;
    const app = new App();
    app.init(root);
});
