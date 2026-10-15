/**
 * Generates the original artwork for the schema-v2 demo products in public/assets: clock, T-shirt
 * and bottle mockups, transparent foreground overlays (clock hands) and sample customer photos.
 * Like generate-fixtures.mjs, everything is drawn from scratch as SVG and rasterised with headless
 * Chrome, so there are no third-party image licences to track and no external image service.
 *
 * The placement rectangles in public/data/products/*.json are derived from the constants below
 * (pixel boxes on a 1600 x 1200 / 1600 x 1600 / 1200 x 1600 canvas); keep them in sync.
 *
 * Usage: npm run generate:demo-assets   (needs Chrome; set CHROME_PATH if it is not at /usr/bin/google-chrome)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

const HEART =
  'M50 92 C 20 68 2 50 2 30 C 2 14 14 4 28 4 C 38 4 46 9 50 18 C 54 9 62 4 72 4 C 86 4 98 14 98 30 C 98 50 80 68 50 92 Z';
/** The heart path scaled into the box (x, y, size) as a transform. */
const heartAt = (x, y, size) => `translate(${x} ${y}) scale(${size / 100})`;

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

const WOOD = `<linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b07a52"/><stop offset=".5" stop-color="#8a5a3b"/><stop offset="1" stop-color="#6e4529"/></linearGradient>`;
const BLUR = (id, s) =>
  `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${s}"/></filter>`;
const GRAIN = `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.10 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;

// ---- clock ------------------------------------------------------------------------------------

/** A wall clock scene: heart frame around `face`, optional strip frame and plaque. */
function clockScene({ face, strip, plaque, wall = ['#efe6da', '#e1d3bf'], title }) {
  const [fx, fy, fs] = face;
  const frame = fs * 1.1;
  const frameX = fx - (frame - fs) / 2;
  const frameY = fy - (frame - fs) / 2;
  let body = `<defs>${WOOD}${BLUR('b', 14)}${GRAIN}
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${wall[0]}"/><stop offset="1" stop-color="${wall[1]}"/></linearGradient></defs>
    <rect width="1600" height="1200" fill="url(#wall)"/><rect width="1600" height="1200" fill="#000" filter="url(#grain)"/>
    <g transform="${heartAt(frameX + 10, frameY + 26, frame)}" fill="#00000050" filter="url(#b)"><path d="${HEART}"/></g>
    <g transform="${heartAt(frameX, frameY, frame)}"><path d="${HEART}" fill="url(#wood)"/><path d="${HEART}" fill="none" stroke="#ffffff30" stroke-width="1.2"/></g>
    <g transform="${heartAt(fx, fy, fs)}"><path d="${HEART}" fill="#fbf8f3"/><path d="${HEART}" fill="none" stroke="#00000022" stroke-width=".8"/></g>`;
  if (strip) {
    const [sx, sy, sw, sh] = strip;
    body += `<rect x="${sx - 220}" y="${sy + sh + 14}" width="${sw + 440}" height="26" fill="url(#wood)"/>
      <rect x="${sx - 220}" y="${sy + sh + 40}" width="${sw + 440}" height="10" fill="#00000030" filter="url(#b)"/>
      <rect x="${sx - 16}" y="${sy - 16}" width="${sw + 32}" height="${sh + 32}" rx="6" fill="url(#wood)"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="#fbf8f3"/>`;
  }
  if (plaque) {
    const [px, py, pw, ph] = plaque;
    body += `<rect x="${px - 10}" y="${py - 10}" width="${pw + 20}" height="${ph + 20}" rx="10" fill="#b08d57"/>
      <rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="#fbf8f3"/>`;
  }
  if (title)
    body += `<text x="40" y="1160" font-family="sans-serif" font-size="30" fill="#00000055">${title}</text>`;
  return body;
}

/** Foreground overlay: clock hands and hub, transparent elsewhere. */
function hands(cx, cy, scale) {
  const hand = (len, w, angle) =>
    `<g transform="translate(${cx} ${cy}) rotate(${angle})"><rect x="${-w / 2}" y="${-len}" width="${w}" height="${len + 14 * scale}" rx="${w / 2}" fill="#1f2937"/></g>`;
  return svg(
    1600,
    1200,
    `
    <g filter="drop-shadow(3px 5px 4px rgba(0,0,0,.35))">${hand(105 * scale, 14 * scale, -60)}${hand(160 * scale, 9 * scale, 60)}
    <circle cx="${cx}" cy="${cy}" r="${16 * scale}" fill="#b08d57"/><circle cx="${cx}" cy="${cy}" r="${7 * scale}" fill="#1f2937"/></g>`,
  );
}

// ---- T-shirt ----------------------------------------------------------------------------------

function shirt({ fabric, back = false, bgA = '#e5e9ef', bgB = '#cfd6e0', label }) {
  const outline =
    'M600 190 Q800 330 1000 190 L1290 300 L1500 620 L1290 760 L1190 640 L1190 1440 L410 1440 L410 640 L310 760 L100 620 L310 300 Z';
  const backOutline =
    'M600 190 Q800 240 1000 190 L1290 300 L1500 620 L1290 760 L1190 640 L1190 1440 L410 1440 L410 640 L310 760 L100 620 L310 300 Z';
  const d = back ? backOutline : outline;
  const dark = fabric !== '#fbfbfa';
  return svg(
    1600,
    1600,
    `<defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
      ${GRAIN}${BLUR('blur', 16)}
    </defs>
    <rect width="1600" height="1600" fill="url(#bg)"/>
    <path d="${d}" fill="#00000026" transform="translate(0 24)" filter="url(#blur)"/>
    <path d="${d}" fill="${fabric}"/><path d="${d}" fill="#000" filter="url(#grain)"/>
    <path d="${back ? 'M600 190 Q800 240 1000 190' : 'M600 190 Q800 330 1000 190'}" fill="none" stroke="${dark ? '#0b1730' : '#d8dbe0'}" stroke-width="26" stroke-linecap="round"/>
    <path d="M410 640 L310 760 M1190 640 L1290 760" stroke="#00000022" stroke-width="3"/>
    <text x="40" y="1570" font-family="sans-serif" font-size="30" fill="#00000055">${label}</text>`,
  );
}

// ---- bottle -----------------------------------------------------------------------------------

/** A glass bottle (1200 x 1600). `tall` stretches the neck for the 750 ml variant. */
function bottle({ tall, label }) {
  const shoulderY = tall ? 560 : 640;
  const neckTop = tall ? 150 : 250;
  const body = `M520 ${neckTop} L680 ${neckTop} L680 ${shoulderY - 150} Q680 ${shoulderY - 20} 900 ${shoulderY + 60} L900 1500 Q900 1530 870 1530 L330 1530 Q300 1530 300 1500 L300 ${shoulderY + 60} Q520 ${shoulderY - 20} 520 ${shoulderY - 150} Z`;
  return svg(
    1200,
    1600,
    `<defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dde6ee"/><stop offset="1" stop-color="#c3d0dc"/></linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1f4d3a"/><stop offset=".35" stop-color="#2f7a58"/><stop offset=".7" stop-color="#1c4634"/><stop offset="1" stop-color="#143325"/></linearGradient>
      ${BLUR('blur', 18)}
    </defs>
    <rect width="1200" height="1600" fill="url(#bg)"/>
    <ellipse cx="600" cy="1548" rx="330" ry="26" fill="#00000040" filter="url(#blur)"/>
    <path d="${body}" fill="url(#glass)"/>
    <path d="M345 ${shoulderY + 120} L345 1480" stroke="#ffffff55" stroke-width="14" stroke-linecap="round"/>
    <rect x="515" y="${neckTop - 70}" width="170" height="86" rx="14" fill="#111827"/>
    <rect x="515" y="${neckTop - 70}" width="170" height="14" rx="7" fill="#ffffff30"/>
    <circle cx="1000" cy="230" r="124" fill="#ffffffcc"/><circle cx="1000" cy="230" r="124" fill="none" stroke="#1f2937" stroke-width="6"/>
    <circle cx="1000" cy="230" r="110" fill="#111827"/>
    <text x="40" y="1570" font-family="sans-serif" font-size="30" fill="#00000055">${label}</text>`,
  );
}

// ---- sample photos ------------------------------------------------------------------------------

const star = (cx, cy, outer, inner, points = 5) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

const photos = [
  [
    'photo-1',
    2400,
    1600,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a8b"/><stop offset=".6" stop-color="#ff6a88"/><stop offset="1" stop-color="#4a1d6b"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="1700" cy="700" r="260" fill="#ffe29a"/><path d="M0 1100 L500 640 L900 1000 L1400 520 L2000 1060 L2400 760 V1600 H0 Z" fill="#2b1055"/><path d="M0 1350 Q600 1150 1200 1330 T2400 1280 V1600 H0 Z" fill="#150836"/>`,
  ],
  [
    'photo-2',
    1600,
    2400,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#43cea2"/><stop offset="1" stop-color="#185a9d"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="800" cy="900" r="360" fill="#ffe8d6"/><rect x="420" y="1280" width="760" height="900" rx="320" fill="#10263f"/><circle cx="680" cy="860" r="34" fill="#10263f"/><circle cx="920" cy="860" r="34" fill="#10263f"/><path d="M660 1020 Q800 1130 940 1020" fill="none" stroke="#10263f" stroke-width="22" stroke-linecap="round"/>`,
  ],
  [
    'photo-3',
    2400,
    1600,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2193b0"/><stop offset="1" stop-color="#6dd5ed"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><path d="M0 1000 Q300 900 600 1000 T1200 1000 T1800 1000 T2400 1000 V1600 H0 Z" fill="#0e5a73"/><path d="M0 1200 Q300 1100 600 1200 T1200 1200 T1800 1200 T2400 1200 V1600 H0 Z" fill="#0a3f52"/><circle cx="600" cy="520" r="200" fill="#fff6c4"/><path d="M1500 880 L1700 520 L1900 880 Z" fill="#fff"/><rect x="1690" y="880" width="20" height="120" fill="#fff"/>`,
  ],
  [
    'photo-4',
    1800,
    1800,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7971e"/><stop offset="1" stop-color="#ffd200"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><g fill="#7a3e00">${[200, 520, 840, 1160, 1480].map((x, i) => `<rect x="${x}" y="${900 - i * 90}" width="240" height="${900 + i * 90}"/>`).join('')}</g><polygon points="${star(900, 420, 200, 80)}" fill="#fff"/>`,
  ],
  [
    'photo-5',
    2400,
    1600,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#134e5e"/><stop offset="1" stop-color="#71b280"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${[200, 560, 920, 1280, 1640, 2000].map((x, i) => `<polygon points="${x},1250 ${x + 180},${520 + (i % 3) * 90} ${x + 360},1250" fill="#0b3b30"/>`).join('')}<rect y="1250" width="${w}" height="350" fill="#0a2f26"/><circle cx="1900" cy="380" r="140" fill="#e8ffd1"/>`,
  ],
  [
    'photo-6',
    1600,
    2000,
    (w, h) =>
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8e2de2"/><stop offset="1" stop-color="#ff6a00"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="800" cy="760" r="300" fill="#ffd7ba"/><path d="M360 1500 Q800 1060 1240 1500 V2000 H360 Z" fill="#22223b"/><circle cx="690" cy="730" r="28" fill="#22223b"/><circle cx="910" cy="730" r="28" fill="#22223b"/><path d="M660 880 Q800 980 940 880" fill="none" stroke="#22223b" stroke-width="20" stroke-linecap="round"/>`,
  ],
  [
    'photo-lowres',
    480,
    320,
    (w, h) =>
      `<rect width="${w}" height="${h}" fill="#355c7d"/><circle cx="360" cy="90" r="40" fill="#f8b195"/><path d="M0 240 L140 120 L240 200 L340 130 L480 250 V320 H0 Z" fill="#6c5b7b"/>`,
  ],
].map(([name, w, h, draw]) => ({
  file: `samples/${name}.jpg`,
  width: w,
  height: h,
  type: 'jpeg',
  svg: svg(w, h, draw(w, h)),
}));

// ---- everything ----------------------------------------------------------------------------------

const assets = [
  // Clock 12 in: face (500,120,600) strip (400,864,800x200)
  {
    file: 'mockups/clock-front.jpg',
    width: 1600,
    height: 1200,
    type: 'jpeg',
    svg: svg(
      1600,
      1200,
      clockScene({
        face: [500, 120, 600],
        strip: [400, 864, 800, 200],
        title: 'Heart clock 12 in - front view (sample mockup)',
      }),
    ),
  },
  {
    file: 'mockups/clock-hands-12.png',
    width: 1600,
    height: 1200,
    type: 'png',
    svg: hands(800, 400, 1),
  },
  // Clock 16 in: face (440,50,720) strip (440,800,720x180) plaque (560,1000,480x90)
  {
    file: 'mockups/clock-front-large.jpg',
    width: 1600,
    height: 1200,
    type: 'jpeg',
    svg: svg(
      1600,
      1200,
      clockScene({
        face: [440, 50, 720],
        strip: [440, 800, 720, 180],
        plaque: [560, 1000, 480, 90],
        wall: ['#e6ece9', '#cfdad5'],
        title: 'Heart clock 16 in - front view (sample mockup)',
      }),
    ),
  },
  {
    file: 'mockups/clock-hands-16.png',
    width: 1600,
    height: 1200,
    type: 'png',
    svg: hands(800, 352, 1.25),
  },
  // Lifestyle: face (560,240,480); the photo strip is a perspective quad in the config.
  {
    file: 'mockups/clock-lifestyle.jpg',
    width: 1600,
    height: 1200,
    type: 'jpeg',
    svg: svg(
      1600,
      1200,
      `<defs>${WOOD}${BLUR('b', 16)}${GRAIN}
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9e2ec"/><stop offset="1" stop-color="#bcccdc"/></linearGradient></defs>
      <rect width="1600" height="1200" fill="url(#wall)"/><rect width="1600" height="1200" fill="#000" filter="url(#grain)"/>
      <rect x="0" y="960" width="1600" height="240" fill="#6e4529"/><rect x="0" y="940" width="1600" height="34" fill="url(#wood)"/>
      <rect x="1180" y="130" width="300" height="420" fill="#fff" opacity=".35"/><rect x="1196" y="146" width="268" height="388" fill="#9fb3c8" opacity=".6"/>
      <g transform="${heartAt(536 + 8, 216 + 22, 528)}" fill="#00000050" filter="url(#b)"><path d="${HEART}"/></g>
      <g transform="${heartAt(536, 216, 528)}"><path d="${HEART}" fill="url(#wood)"/></g>
      <g transform="${heartAt(560, 240, 480)}"><path d="${HEART}" fill="#fbf8f3"/></g>
      <polygon points="410,945 430,800 1170,790 1190,930" fill="#6e4529"/><polygon points="430,800 1170,790 1190,930 410,945" fill="none" stroke="#00000030" stroke-width="3"/>
      <polygon points="430,800 1170,790 1190,930 410,945" fill="#fbf8f3"/>
      <text x="40" y="1160" font-family="sans-serif" font-size="30" fill="#ffffff88">Heart clock - lifestyle view (sample mockup)</text>`,
    ),
  },
  {
    file: 'mockups/clock-hands-life.png',
    width: 1600,
    height: 1200,
    type: 'png',
    svg: hands(800, 442, 0.85),
  },

  // T-shirts (the existing tshirt-white.jpg is the white front)
  {
    file: 'mockups/tshirt-white-back.jpg',
    width: 1600,
    height: 1600,
    type: 'jpeg',
    svg: shirt({ fabric: '#fbfbfa', back: true, label: 'T-shirt white - back (sample mockup)' }),
  },
  {
    file: 'mockups/tshirt-navy-front.jpg',
    width: 1600,
    height: 1600,
    type: 'jpeg',
    svg: shirt({
      fabric: '#1e2a4a',
      bgA: '#eef1f6',
      bgB: '#d3dae6',
      label: 'T-shirt navy - front (sample mockup)',
    }),
  },
  {
    file: 'mockups/tshirt-navy-back.jpg',
    width: 1600,
    height: 1600,
    type: 'jpeg',
    svg: shirt({
      fabric: '#1e2a4a',
      back: true,
      bgA: '#eef1f6',
      bgB: '#d3dae6',
      label: 'T-shirt navy - back (sample mockup)',
    }),
  },

  // Bottles
  {
    file: 'mockups/bottle-500-front.jpg',
    width: 1200,
    height: 1600,
    type: 'jpeg',
    svg: bottle({ tall: false, label: 'Bottle 500 ml - front (sample mockup)' }),
  },
  {
    file: 'mockups/bottle-500-back.jpg',
    width: 1200,
    height: 1600,
    type: 'jpeg',
    svg: bottle({ tall: false, label: 'Bottle 500 ml - back (sample mockup)' }),
  },
  {
    file: 'mockups/bottle-750-front.jpg',
    width: 1200,
    height: 1600,
    type: 'jpeg',
    svg: bottle({ tall: true, label: 'Bottle 750 ml - front (sample mockup)' }),
  },
  {
    file: 'mockups/bottle-750-back.jpg',
    width: 1200,
    height: 1600,
    type: 'jpeg',
    svg: bottle({ tall: true, label: 'Bottle 750 ml - back (sample mockup)' }),
  },

  // Product-list thumbnails are the first mockup of each product; no extra files needed.
  ...photos,
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
      ...(asset.type === 'jpeg' ? { quality: 86 } : { omitBackground: true }),
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
