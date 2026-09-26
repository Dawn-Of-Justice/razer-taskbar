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
 * Battery style uses the exact glyphs Windows draws for its own battery icon; the hand-drawn battery below
 * is only a fallback for systems without the Segoe icon fonts.
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

    // ---------- Windows' own battery glyphs (Segoe Fluent Icons on Win 11, Segoe MDL2 Assets on Win 10) ----------
    const GLYPH_FONT = '"Segoe Fluent Icons", "Segoe MDL2 Assets"';
    const BATTERY = ['\uE850', '\uE851', '\uE852', '\uE853', '\uE854', '\uE855', '\uE856', '\uE857', '\uE858', '\uE859', '\uE83F'];
    const BATTERY_CHARGING = ['\uE85A', '\uE85B', '\uE85C', '\uE85D', '\uE85E', '\uE85F', '\uE860', '\uE861', '\uE862', '\uE83E', '\uEA93'];
    const BATTERY_UNKNOWN = '\uE996';

    function hasGlyphFont(ctx: CanvasRenderingContext2D): boolean {
        ctx.font = `32px ${GLYPH_FONT}, "__rt_missing_font__"`;
        const withFont = ctx.measureText(BATTERY[10]).width;
        ctx.font = '32px "__rt_missing_font__"';
        const without = ctx.measureText(BATTERY[10]).width;
        return withFont !== without;
    }

    /** Draw text centred on its ink box, snapped to whole pixels so it stays crisp like the shell's icons. */
    function drawCentered(ctx: CanvasRenderingContext2D, text: string, S: number, fontCss: string) {
        ctx.font = fontCss;
        const m = ctx.measureText(text);
        const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        const x = Math.round((S - inkW) / 2 + m.actualBoundingBoxLeft);
        const y = Math.round((S - inkH) / 2 + m.actualBoundingBoxAscent);
        ctx.fillText(text, x, y);
    }

    function glyphFor(): string {
        if (spec.percent === null) { return BATTERY_UNKNOWN; }
        // Same 10% steps the Windows battery flyout uses; any charge above 0 shows at least one bar.
        const step = spec.percent <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(spec.percent / 10)));
        return (spec.charging ? BATTERY_CHARGING : BATTERY)[step];
    }

    function drawGlyph(ctx: CanvasRenderingContext2D, S: number) {
        ctx.fillStyle = fg;
        ctx.globalAlpha = spec.off ? 0.4 : spec.percent === null ? 0.7 : 1;
        // The shell draws these glyphs at 16px per 100% scale, i.e. font size == icon size.
        drawCentered(ctx, glyphFor(), S, `${S}px ${GLYPH_FONT}`);
        ctx.globalAlpha = 1;
    }

    /**
     * Percentage style: just the number, as big and crisp as the square allows, in the Windows UI font.
     * Colour carries the state (green = charging, red = low, dimmed = headset off).
     * 100% has no room for three digits at 16 px, so it shows the full battery glyph instead.
     */
    function drawNumber(ctx: CanvasRenderingContext2D, S: number, glyphs: boolean) {
        if (spec.percent === null || spec.percent >= 100) {
            if (glyphs) { drawGlyph(ctx, S); } else { drawBattery(ctx, S); }
            return;
        }
        const text = String(spec.percent);
        ctx.fillStyle = spec.charging ? green : spec.low ? red : fg;
        ctx.globalAlpha = spec.off ? 0.4 : 1;

        // Aim for digits ~75% of the icon height; allow up to 15% horizontal condensing so two digits
        // stay tall at 16 px, and shrink only if they still would not fit.
        const maxH = S * 0.75;
        const minScaleX = 0.85;
        let size = S;
        let m: TextMetrics;
        let inkW = 0;
        let inkH = 0;
        for (; size > 6; size -= 0.5) {
            ctx.font = `600 ${size}px ${font}`;
            m = ctx.measureText(text);
            inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
            inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
            if (inkH <= maxH && inkW * minScaleX <= S) { break; }
        }
        const scaleX = Math.min(1, S / inkW);
        const x = (S - inkW * scaleX) / 2 + m.actualBoundingBoxLeft * scaleX;
        const y = Math.round((S - inkH) / 2 + m.actualBoundingBoxAscent);
        ctx.save();
        ctx.translate(Math.round(x * 2) / 2, y);
        ctx.scale(scaleX, 1);
        ctx.fillText(text, 0, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    const canvas = document.createElement('canvas');
    const glyphs = hasGlyphFont(canvas.getContext('2d'));
    return sizes.map(S => {
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, S, S);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (spec.style === 'number') {
            drawNumber(ctx, S, glyphs);
        } else if (glyphs) {
            drawGlyph(ctx, S);
        } else {
            drawBattery(ctx, S); // fallback when the Windows icon font is unavailable
        }
        return canvas.toDataURL('image/png');
    });
}
