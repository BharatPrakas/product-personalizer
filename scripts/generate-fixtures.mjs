/**
 * Generates the original demo artwork in public/assets (mockups, clipart, fixed logo, sample
 * photos) by rendering hand-written SVG with headless Chrome. Everything here is drawn from
 * scratch for this project, so there are no third-party image licences to track. The fonts in
 * public/assets/fonts are Liberation fonts (SIL OFL 1.1, licence file alongside).
 *
 * Usage: npm run generate:fixtures   (needs Chrome; set CHROME_PATH if it is not at /usr/bin/google-chrome)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

const star = (cx, cy, outer, inner, points = 5) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

const clipart = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${body}</svg>`;

const fabric = (id, base, opacity = 0.18) => `
  <filter id="${id}" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${opacity} 0"/>
    <feComposite in2="SourceGraphic" operator="in"/>
  </filter>`;

const assets = [
  // ---- mockups (placement rectangles are noted so the sample configs stay in sync) ----
  {
    file: 'mockups/tote-natural.jpg',
    width: 1600,
    height: 1600,
    type: 'jpeg', // print area x .25 y .33 w .5 h .5
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1600" width="1600" height="1600">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f5"/><stop offset="1" stop-color="#d9dee6"/></linearGradient>
        ${fabric('tex', '#000')}
        <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
      </defs>
      <rect width="1600" height="1600" fill="url(#wall)"/>
      <ellipse cx="800" cy="1500" rx="560" ry="46" fill="#00000030" filter="url(#blur)"/>
      <path d="M470 470 C 470 140, 1130 140, 1130 470" fill="none" stroke="#cdbf9f" stroke-width="58" stroke-linecap="round"/>
      <path d="M470 470 C 470 140, 1130 140, 1130 470" fill="none" stroke="#e2d6b8" stroke-width="40" stroke-linecap="round"/>
      <path d="M300 440 H1300 L1330 1440 Q1332 1470 1300 1470 H300 Q268 1470 270 1440 Z" fill="#e8dcc0"/>
      <path d="M300 440 H1300 L1330 1440 Q1332 1470 1300 1470 H300 Q268 1470 270 1440 Z" fill="#000" filter="url(#tex)"/>
      <path d="M300 440 H1300 L1304 520 H296 Z" fill="#00000012"/>
      <path d="M300 1380 H1300" stroke="#00000014" stroke-width="4"/>
    </svg>`,
  },
  {
    file: 'mockups/tshirt-white.jpg',
    width: 1600,
    height: 1600,
    type: 'jpeg', // print area x .32 y .30 w .36 h .42
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1600" width="1600" height="1600">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e5e9ef"/><stop offset="1" stop-color="#cfd6e0"/></linearGradient>
        ${fabric('tex', '#000', 0.1)}
        <filter id="blur"><feGaussianBlur stdDeviation="16"/></filter>
      </defs>
      <rect width="1600" height="1600" fill="url(#bg)"/>
      <path id="shirt" d="M600 190 Q800 330 1000 190 L1290 300 L1500 620 L1290 760 L1190 640 L1190 1440 L410 1440 L410 640 L310 760 L100 620 L310 300 Z" fill="#00000026" transform="translate(0 24)" filter="url(#blur)"/>
      <path d="M600 190 Q800 330 1000 190 L1290 300 L1500 620 L1290 760 L1190 640 L1190 1440 L410 1440 L410 640 L310 760 L100 620 L310 300 Z" fill="#fbfbfa"/>
      <path d="M600 190 Q800 330 1000 190 L1290 300 L1500 620 L1290 760 L1190 640 L1190 1440 L410 1440 L410 640 L310 760 L100 620 L310 300 Z" fill="#000" filter="url(#tex)"/>
      <path d="M600 190 Q800 330 1000 190" fill="none" stroke="#d8dbe0" stroke-width="26" stroke-linecap="round"/>
      <path d="M410 640 L310 760 M1190 640 L1290 760" stroke="#00000018" stroke-width="3"/>
    </svg>`,
  },
  {
    file: 'mockups/poster-frame.jpg',
    width: 1600,
    height: 1200,
    type: 'jpeg', // print area x .275 y .10 w .45 h .80
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1200" width="1600" height="1200">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6cfc4"/><stop offset="1" stop-color="#c3bbae"/></linearGradient>
        <filter id="blur"><feGaussianBlur stdDeviation="22"/></filter>
      </defs>
      <rect width="1600" height="1200" fill="url(#wall)"/>
      <rect x="0" y="1090" width="1600" height="110" fill="#8d7a63"/>
      <rect x="0" y="1082" width="1600" height="10" fill="#00000022"/>
      <rect x="420" y="130" width="780" height="1000" fill="#00000040" filter="url(#blur)"/>
      <rect x="410" y="90" width="780" height="1020" fill="#3b2a1d"/>
      <rect x="426" y="106" width="748" height="988" fill="#5a4230"/>
      <rect x="440" y="120" width="720" height="960" fill="#ffffff"/>
    </svg>`,
  },
  // ---- clipart (transparent PNG) ----
  {
    file: 'clipart/star.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<polygon points="${star(128, 134, 112, 48)}" fill="#f5b301" stroke="#b57f00" stroke-width="8" stroke-linejoin="round"/>`,
    ),
  },
  {
    file: 'clipart/heart.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<path d="M128 226 C 40 162 22 112 22 80 C 22 44 52 26 78 26 C 100 26 118 38 128 58 C 138 38 156 26 178 26 C 204 26 234 44 234 80 C 234 112 216 162 128 226 Z" fill="#e5484d" stroke="#a82a2f" stroke-width="8" stroke-linejoin="round"/>`,
    ),
  },
  {
    file: 'clipart/moon.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<defs><mask id="m"><rect width="256" height="256" fill="#fff"/><circle cx="170" cy="100" r="82" fill="#000"/></mask></defs><circle cx="118" cy="132" r="98" fill="#f2c94c" mask="url(#m)"/><circle cx="118" cy="132" r="98" fill="none"/>`,
    ),
  },
  {
    file: 'clipart/sun.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<g stroke="#f59e0b" stroke-width="14" stroke-linecap="round">${Array.from(
        { length: 12 },
        (_, i) => {
          const a = (Math.PI * 2 * i) / 12;
          return `<line x1="${(128 + 78 * Math.cos(a)).toFixed(1)}" y1="${(128 + 78 * Math.sin(a)).toFixed(1)}" x2="${(128 + 112 * Math.cos(a)).toFixed(1)}" y2="${(128 + 112 * Math.sin(a)).toFixed(1)}"/>`;
        },
      ).join(
        '',
      )}</g><circle cx="128" cy="128" r="56" fill="#fbbf24" stroke="#d97706" stroke-width="8"/>`,
    ),
  },
  {
    file: 'clipart/leaf.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<path d="M36 220 C 36 100 108 34 222 34 C 222 142 160 220 36 220 Z" fill="#2f9e5b" stroke="#1d6b3c" stroke-width="8" stroke-linejoin="round"/><path d="M44 212 C 90 150 140 100 200 56" fill="none" stroke="#1d6b3c" stroke-width="8" stroke-linecap="round"/>`,
    ),
  },
  {
    file: 'clipart/paw.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<g fill="#6d4c41"><ellipse cx="128" cy="170" rx="58" ry="46"/><ellipse cx="52" cy="112" rx="22" ry="30" transform="rotate(-20 52 112)"/><ellipse cx="102" cy="68" rx="22" ry="32" transform="rotate(-6 102 68)"/><ellipse cx="154" cy="68" rx="22" ry="32" transform="rotate(6 154 68)"/><ellipse cx="204" cy="112" rx="22" ry="30" transform="rotate(20 204 112)"/></g>`,
    ),
  },
  {
    file: 'clipart/logo-mark.png',
    width: 256,
    height: 256,
    type: 'png',
    svg: clipart(
      `<circle cx="128" cy="128" r="116" fill="#296fd7"/><circle cx="128" cy="128" r="104" fill="none" stroke="#fff" stroke-width="6"/><path d="M52 176 L110 88 L146 142 L168 112 L204 176 Z" fill="#fff"/><circle cx="170" cy="78" r="16" fill="#fff"/>`,
    ),
  },
  // ---- sample photos for trying uploads ----
  {
    file: 'samples/photo-landscape.jpg',
    width: 1800,
    height: 1200,
    type: 'jpeg',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1800 1200" width="1800" height="1200">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b5fa8"/><stop offset=".65" stop-color="#f4a261"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient></defs>
      <rect width="1800" height="1200" fill="url(#sky)"/>
      <circle cx="1250" cy="640" r="140" fill="#fff3c4"/>
      <path d="M0 800 Q300 560 620 760 T1260 740 T1800 700 V1200 H0 Z" fill="#3a5a40"/>
      <path d="M0 920 Q420 760 900 900 T1800 860 V1200 H0 Z" fill="#2d4a35"/>
      <path d="M0 1040 Q500 930 1000 1030 T1800 990 V1200 H0 Z" fill="#1f3326"/>
      <polygon points="${star(300, 200, 22, 9)}" fill="#fff"/><polygon points="${star(620, 120, 16, 6)}" fill="#fff"/><polygon points="${star(1500, 260, 18, 7)}" fill="#fff"/>
    </svg>`,
  },
  {
    file: 'samples/photo-portrait.jpg',
    width: 1000,
    height: 1500,
    type: 'jpeg',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1500" width="1000" height="1500">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b2cbf"/><stop offset="1" stop-color="#ff6b6b"/></linearGradient></defs>
      <rect width="1000" height="1500" fill="url(#g)"/>
      <circle cx="500" cy="520" r="230" fill="#ffd6a5"/>
      <rect x="250" y="760" width="500" height="560" rx="200" fill="#1e293b"/>
      <circle cx="420" cy="500" r="22" fill="#1e293b"/><circle cx="580" cy="500" r="22" fill="#1e293b"/>
      <path d="M410 600 Q500 680 590 600" fill="none" stroke="#1e293b" stroke-width="14" stroke-linecap="round"/>
    </svg>`,
  },
];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage();
  for (const asset of assets) {
    await page.setViewport({ width: asset.width, height: asset.height, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${asset.svg}`,
    );
    const bytes = await page.screenshot({
      type: asset.type,
      ...(asset.type === 'jpeg' ? { quality: 88 } : { omitBackground: true }),
      clip: { x: 0, y: 0, width: asset.width, height: asset.height },
    });
    const target = join(root, asset.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    console.log(
      `${asset.file}  ${asset.width}x${asset.height}  ${(bytes.length / 1024).toFixed(0)} KB`,
    );
  }
} finally {
  await browser.close();
}
