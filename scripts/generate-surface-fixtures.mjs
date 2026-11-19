/**
 * Generates the original product photographs used by the surface / boundary regression tests
 * (tests/browser/host/fixtures): a transparent supplement jar with a white wraparound label seen
 * straight on, and a dark spray bottle photographed at an angle whose label has curved top and
 * bottom edges. Both are drawn from scratch (no third-party images), together with
 * `surface-fixtures.json`: the label geometry in fractions of each photograph (rectangle, and for the
 * spray bottle the Bezier outline of the tilted label), so tests can state exactly where artwork must
 * and must not appear.
 *
 * Usage: node scripts/generate-surface-fixtures.mjs   (needs Chrome; set CHROME_PATH if it is not at /usr/bin/google-chrome)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'browser', 'host', 'fixtures');
mkdirSync(out, { recursive: true });

const SUPP = { w: 480, h: 480, label: { x: 135, y: 190, w: 210, h: 190 } };
// The spray label sits in the bottle's own (unrotated) frame: straight sides, edges that sag towards the viewer.
const SPRAY = { w: 480, h: 640, angle: -20, cx: 240, cy: 330, label: { x0: 170, x1: 310, top: 250, bottom: 410, sag: 14 } };

const r = (n) => Math.round(n * 1e4) / 1e4;
const rot = (x, y) => {
  const a = (SPRAY.angle * Math.PI) / 180;
  const dx = x - SPRAY.cx;
  const dy = y - SPRAY.cy;
  return [SPRAY.cx + dx * Math.cos(a) - dy * Math.sin(a), SPRAY.cy + dx * Math.sin(a) + dy * Math.cos(a)];
};
const norm = ([x, y]) => [r(x / SPRAY.w), r(y / SPRAY.h)];

/** The tilted label as a closed Bezier path (photo fractions): quadratic sags written as cubic handles. */
function sprayOutline() {
  const { x0, x1, top, bottom, sag } = SPRAY.label;
  const tl = rot(x0, top);
  const tr = rot(x1, top);
  const br = rot(x1, bottom);
  const bl = rot(x0, bottom);
  const topCtl = rot((x0 + x1) / 2, top + 2 * sag);
  const botCtl = rot((x0 + x1) / 2, bottom + 2 * sag);
  const cub = (p0, ctl, p1) => [[p0[0] + (2 / 3) * (ctl[0] - p0[0]), p0[1] + (2 / 3) * (ctl[1] - p0[1])], [p1[0] + (2 / 3) * (ctl[0] - p1[0]), p1[1] + (2 / 3) * (ctl[1] - p1[1])]];
  const [tlOut, trIn] = cub(tl, topCtl, tr);
  const [brOut, blIn] = cub(br, botCtl, bl);
  const a = (p, hin, hout) => ({ x: norm(p)[0], y: norm(p)[1], ...(hin ? { handleIn: norm(hin) } : {}), ...(hout ? { handleOut: norm(hout) } : {}) });
  return {
    version: 1,
    fillRule: 'nonzero',
    contours: [{ anchors: [a(tl, null, tlOut), a(tr, trIn, null), a(br, null, brOut), a(bl, blIn, null)] }],
  };
}

const supplementSvg = () => {
  const { w, h, label: l } = SUPP;
  const caps = Array.from({ length: 26 }, (_, i) => {
    const x = 128 + ((i * 53) % 230);
    const y = 150 + ((i * 37) % 280);
    const a = (i * 47) % 180;
    return `<ellipse cx="${x}" cy="${y}" rx="26" ry="11" fill="#efe3c9" stroke="#d9c9a6" stroke-width="1.5" transform="rotate(${a} ${x} ${y})"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6d6b0"/><stop offset="1" stop-color="#d9c79c"/></linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".18" stop-color="#ffffff" stop-opacity=".12"/><stop offset=".82" stop-color="#ffffff" stop-opacity=".12"/><stop offset="1" stop-color="#ffffff" stop-opacity=".5"/></linearGradient>
      <linearGradient id="roll" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".22" stop-color="#000" stop-opacity=".04"/><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset=".78" stop-color="#000" stop-opacity=".04"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <ellipse cx="240" cy="452" rx="140" ry="14" fill="#00000026"/>
    <rect x="110" y="128" width="260" height="318" rx="46" fill="#ffffff" fill-opacity=".18" stroke="#ffffff" stroke-opacity=".6" stroke-width="2"/>
    ${caps}
    <rect x="110" y="128" width="260" height="318" rx="46" fill="url(#glass)"/>
    <rect x="122" y="66" width="236" height="66" rx="8" fill="#16181c"/>
    <rect x="122" y="66" width="236" height="12" rx="6" fill="#ffffff" fill-opacity=".12"/>
    <rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" fill="#fbfbf9"/>
    <rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" fill="url(#roll)"/>
  </svg>`;
};

const spraySvg = () => {
  const { w, h, cx, cy, angle, label: l } = SPRAY;
  const sagPath = (y, dy) => `M${l.x0} ${y} Q${(l.x0 + l.x1) / 2} ${y + 2 * dy} ${l.x1} ${y}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a4a32"/><stop offset=".6" stop-color="#b9805a"/><stop offset="1" stop-color="#d9a77f"/></linearGradient>
      <linearGradient id="body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0b0b0d"/><stop offset=".35" stop-color="#2a2b30"/><stop offset=".6" stop-color="#17171a"/><stop offset="1" stop-color="#050506"/></linearGradient>
      <linearGradient id="roll" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset=".25" stop-color="#000" stop-opacity=".03"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".34"/></linearGradient>
      <clipPath id="label"><path d="${sagPath(l.top, l.sag)} L${l.x1} ${l.bottom} Q${(l.x0 + l.x1) / 2} ${l.bottom + 2 * l.sag} ${l.x0} ${l.bottom} Z"/></clipPath>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#wall)"/>
    <g transform="rotate(${angle} ${cx} ${cy})">
      <rect x="215" y="40" width="50" height="46" rx="6" fill="#111"/><rect x="226" y="20" width="60" height="22" rx="6" fill="#1b1b1e"/>
      <rect x="208" y="86" width="64" height="42" rx="8" fill="#141416"/>
      <path d="M150 190 Q150 150 240 150 Q330 150 330 190 L330 520 Q330 560 240 560 Q150 560 150 520 Z" fill="url(#body)"/>
      <g clip-path="url(#label)"><rect x="${l.x0}" y="${l.top - 10}" width="${l.x1 - l.x0}" height="${l.bottom - l.top + 60}" fill="#f4f4f1"/>
      <rect x="${l.x0}" y="${l.top - 10}" width="${l.x1 - l.x0}" height="${l.bottom - l.top + 60}" fill="url(#roll)"/></g>
    </g>
  </svg>`;
};

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  for (const [name, size, svg] of [
    ['supplement-bottle', SUPP, supplementSvg()],
    ['spray-bottle', SPRAY, spraySvg()],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: size.w, height: size.h });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    writeFileSync(join(out, `${name}.png`), await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h } }));
    await page.close();
  }
} finally {
  await browser.close();
}

const l = SUPP.label;
writeFileSync(
  join(out, 'surface-fixtures.json'),
  JSON.stringify(
    {
      supplement: { width: SUPP.w, height: SUPP.h, label: { x: r(l.x / SUPP.w), y: r(l.y / SUPP.h), width: r(l.w / SUPP.w), height: r(l.h / SUPP.h) } },
      spray: {
        width: SPRAY.w,
        height: SPRAY.h,
        angle: SPRAY.angle,
        // The label's frame before tilting, as a placement rectangle (fractions of the photo) that
        // `rotation` turns about its own centre; the centre does not move when the bottle is tilted.
        placement: {
          x: r((SPRAY.cx - (SPRAY.label.x1 - SPRAY.label.x0) / 2) / SPRAY.w),
          y: r((SPRAY.cy - (SPRAY.label.bottom - SPRAY.label.top) / 2) / SPRAY.h),
          width: r((SPRAY.label.x1 - SPRAY.label.x0) / SPRAY.w),
          height: r((SPRAY.label.bottom - SPRAY.label.top) / SPRAY.h),
          rotation: SPRAY.angle,
        },
        outline: sprayOutline(),
      },
    },
    null,
    2,
  ) + '\n',
);
console.log('written to', out);
