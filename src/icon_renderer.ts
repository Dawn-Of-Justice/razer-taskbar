import { BrowserWindow, NativeImage, nativeImage } from 'electron';
import type { IconStyle } from './shared_types';

export interface IconSpec {
    style: IconStyle;
    /** null = unknown / no device */
    percent: number | null;
    charging: boolean;
    off: boolean;
    low: boolean;
    /** true when the Windows taskbar uses the light theme (draw dark glyphs). */
    lightTaskbar: boolean;
}

/** Tray icon sizes per display scale factor (100% .. 200%). */
const TRAY_SIZES: [scaleFactor: number, size: number][] = [[1, 16], [1.25, 20], [1.5, 24], [1.75, 28], [2, 32]];

/**
 * Renders Windows 11 style tray icons at runtime with a hidden, sandboxed window's <canvas>.
 * This gives crisp, per-DPI icons in the system font (Segoe UI Variable) for any percentage,
 * matched to the taskbar theme, instead of shipping hundreds of pre-rendered PNGs.
 */
export class IconRenderer {
    private window: BrowserWindow | null = null;
    private ready: Promise<void> | null = null;
    private readonly cache = new Map<string, NativeImage>();

    init(): Promise<void> {
        if (!this.ready) {
            this.window = new BrowserWindow({
                show: false,
                width: 64,
                height: 64,
                skipTaskbar: true,
                webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
            });
            this.ready = this.window.loadURL('about:blank');
        }
        return this.ready;
    }

    dispose(): void {
        this.window?.destroy();
        this.window = null;
        this.ready = null;
    }

    /** Multi-resolution tray image. */
    async renderTrayImage(spec: IconSpec): Promise<NativeImage> {
        const key = JSON.stringify(normalize(spec));
        const cached = this.cache.get(key);
        if (cached) { return cached; }

        const urls = await this.drawDataUrls(spec, TRAY_SIZES.map(([, size]) => size));
        const image = nativeImage.createEmpty();
        TRAY_SIZES.forEach(([scaleFactor], i) => image.addRepresentation({ scaleFactor, dataURL: urls[i] }));

        if (this.cache.size > 256) { this.cache.clear(); }
        this.cache.set(key, image);
        return image;
    }

    /** Single size data URL, used for previews in the settings window. */
    async renderDataUrl(spec: IconSpec, size: number): Promise<string> {
        const [url] = await this.drawDataUrls(spec, [Math.max(8, Math.min(256, Math.round(size)))]);
        return url;
    }

    private async drawDataUrls(spec: IconSpec, sizes: number[]): Promise<string[]> {
        await this.init();
        const script = `(${drawIcons.toString()})(${JSON.stringify(normalize(spec))}, ${JSON.stringify(sizes)})`;
        return await this.window.webContents.executeJavaScript(script, true);
    }
}

function normalize(spec: IconSpec): IconSpec {
    return {
        style: spec.style,
        percent: spec.percent === null ? null : Math.max(0, Math.min(100, Math.round(spec.percent))),
        charging: !!spec.charging && !spec.off,
        off: !!spec.off,
        low: !!spec.low && !spec.charging && !spec.off,
        lightTaskbar: !!spec.lightTaskbar,
    };
}

/**
 * Runs inside the hidden renderer. Must be fully self-contained (no references to outer scope).
 * Geometry is computed in whole pixels per size so strokes stay crisp at 100% scaling.
 */
function drawIcons(spec: IconSpec, sizes: number[]): string[] {
    const fg = spec.lightTaskbar ? '#1b1b1b' : '#ffffff';
    const red = spec.lightTaskbar ? '#c42b1c' : '#ff5b5b';
    const green = spec.lightTaskbar ? '#0f7b0f' : '#6ccb5f';
    const font = '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

    function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    function boltPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
        const w = h * 0.62;
        const pts = [[0.60, 0], [0.08, 0.57], [0.45, 0.57], [0.36, 1], [0.92, 0.40], [0.55, 0.40], [0.66, 0]];
        ctx.beginPath();
        pts.forEach(([px, py], i) => {
            const x = cx - w / 2 + px * w;
            const y = cy - h / 2 + py * h;
            if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
        });
        ctx.closePath();
    }

    function drawBolt(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number, knockout: number, color: string) {
        ctx.save();
        boltPath(ctx, cx, cy, h);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = knockout * 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
    }

    function drawBattery(ctx: CanvasRenderingContext2D, S: number) {
        const lw = Math.max(1, Math.round(S / 16));
        const bodyW = Math.round(S * 14 / 16);
        const bodyH = Math.round(S * 8 / 16 / 2) * 2;
        const nubW = Math.max(2, Math.round(S * 1.5 / 16));
        const nubH = Math.max(2, Math.round(bodyH * 0.45 / 2) * 2);
        const left = Math.floor((S - bodyW - nubW) / 2);
        const top = Math.round((S - bodyH) / 2);
        const radius = S * 2.25 / 16;
        const dim = spec.percent === null || spec.off;

        const gap = lw;
        const innerX = left + lw;
        const innerY = top + lw;
        const innerW = bodyW - 2 * lw;
        const innerH = bodyH - 2 * lw;

        // Level fill
        if (!dim) {
            const fullW = innerW - 2 * gap;
            const pct = spec.percent as number;
            const fw = pct <= 0 ? 0 : Math.max(Math.max(1, lw), Math.round(fullW * pct / 100));
            if (fw > 0) {
                ctx.fillStyle = spec.low ? red : fg;
                roundRect(ctx, innerX + gap, innerY + gap, fw, innerH - 2 * gap, Math.max(0.5, radius - lw - gap));
                ctx.fill();
            }
        }

        // Charging bolt sits inside the body; it is cut out of the fill so it stays readable at any level.
        if (spec.charging) {
            const boltH = innerH + lw;
            drawBolt(ctx, innerX + innerW / 2, top + bodyH / 2, boltH, lw * 0.75, fg);
        }

        // Outline + terminal drawn last so nothing cuts into them.
        ctx.globalAlpha = dim ? 0.5 : 1;
        ctx.strokeStyle = fg;
        ctx.lineWidth = lw;
        roundRect(ctx, left + lw / 2, top + lw / 2, bodyW - lw, bodyH - lw, radius);
        ctx.stroke();
        ctx.fillStyle = fg;
        roundRect(ctx, left + bodyW, top + (bodyH - nubH) / 2, nubW, nubH, nubW / 2);
        ctx.fill();
        ctx.fillRect(left + bodyW, top + (bodyH - nubH) / 2, Math.ceil(nubW / 2), nubH);
        ctx.globalAlpha = 1;

        if (spec.off) {
            // Diagonal slash, knocked out from the glyph for legibility.
            ctx.save();
            ctx.lineCap = 'round';
            const a = [S * 0.18, S * 0.85];
            const b = [S * 0.78, S * 0.15];
            ctx.globalCompositeOperation = 'destination-out';
            ctx.lineWidth = lw * 3;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = fg;
            ctx.lineWidth = lw * 1.25;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
            ctx.restore();
        }
    }

    function drawNumber(ctx: CanvasRenderingContext2D, S: number) {
        const barH = Math.max(2, Math.round(S / 8));
        const textAreaH = S - barH - Math.max(1, Math.round(S / 16));
        const dim = spec.percent === null || spec.off;
        const text = spec.off ? 'off' : spec.percent === null ? '?' : String(spec.percent);

        // Fit the text into the square: as tall as possible, condensed horizontally if needed ("100").
        let fontSize = Math.round(textAreaH * 1.3);
        ctx.font = `600 ${fontSize}px ${font}`;
        let m = ctx.measureText(text);
        let glyphH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        if (glyphH > textAreaH) {
            fontSize = Math.floor(fontSize * textAreaH / glyphH);
            ctx.font = `600 ${fontSize}px ${font}`;
            m = ctx.measureText(text);
            glyphH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        }
        const glyphW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        const scaleX = Math.min(1, (S + 0.5) / glyphW);

        ctx.save();
        ctx.globalAlpha = dim ? 0.55 : 1;
        ctx.fillStyle = spec.low ? red : fg;
        ctx.translate(S / 2, 0);
        ctx.scale(scaleX, 1);
        const x = -glyphW / 2 + m.actualBoundingBoxLeft;
        const y = Math.round((textAreaH - glyphH) / 2 + m.actualBoundingBoxAscent);
        ctx.fillText(text, x, y);
        ctx.restore();

        // Level bar
        const barY = S - barH;
        const inset = Math.max(1, Math.round(S / 16));
        const barW = S - inset * 2;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = fg;
        roundRect(ctx, inset, barY, barW, barH, barH / 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (!dim) {
            const pct = spec.percent as number;
            const w = pct <= 0 ? 0 : Math.max(barH, Math.round(barW * pct / 100));
            if (w > 0) {
                ctx.fillStyle = spec.charging ? green : spec.low ? red : fg;
                roundRect(ctx, inset, barY, w, barH, barH / 2);
                ctx.fill();
            }
        }
    }

    const canvas = document.createElement('canvas');
    return sizes.map(S => {
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, S, S);
        if (spec.style === 'number') {
            drawNumber(ctx, S);
        } else {
            drawBattery(ctx, S);
        }
        return canvas.toDataURL('image/png');
    });
}
