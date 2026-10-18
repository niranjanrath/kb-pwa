// Generates the PWA icons (PNG, no dependencies) plus a matching SVG. Run: npm run icons
import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const BG = [44, 110, 105];
const FG = [255, 255, 255];
const ACCENT = [44, 110, 105];

// Distance helpers on a 0..1 canvas; icon = rounded square + folded-corner page with text lines.
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function sample(x, y, { maskable }) {
  // returns [r,g,b,a] for a point
  const scale = maskable ? 0.74 : 0.86; // content size (maskable keeps inside the safe zone)
  const bg = maskable ? true : inRoundRect(x, y, 0, 0, 1, 1, 0.22);
  if (!bg) return [0, 0, 0, 0];
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  // page: x 0.27..0.73, y 0.16..0.84, folded corner top-right
  const fold = 0.14;
  const onPage = inRoundRect(u, v, 0.27, 0.16, 0.73, 0.84, 0.045) && !(u > 0.73 - fold && v < 0.16 + fold && u - (0.73 - fold) > -(v - (0.16 + fold)) + 0);
  const corner = u > 0.73 - fold && u <= 0.73 && v >= 0.16 && v < 0.16 + fold && (u - (0.73 - fold)) <= ((0.16 + fold) - v);
  const line = (yy) => u > 0.35 && u < 0.65 && Math.abs(v - yy) < 0.02;
  if (onPage || corner) {
    if (corner) return [...ACCENT.map((c) => Math.round(c * 0.5 + 255 * 0.5)), 255];
    if (line(0.44) || line(0.56) || (line(0.68) && u < 0.54)) return [...ACCENT, 255];
    return [...FG, 255];
  }
  return [...BG, 255];
}

function png(size, opts) {
  const SS = 3; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      const n = SS * SS;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="113" fill="#2c6e69"/>
  <g transform="translate(256 256) scale(.86) translate(-256 -256)">
    <path d="M160 82h126l66 66v266a24 24 0 0 1-24 24H160a24 24 0 0 1-24-24V106a24 24 0 0 1 24-24z" fill="#fff"/>
    <path d="M286 82l66 66h-48a18 18 0 0 1-18-18z" fill="#97b6b3"/>
    <path d="M180 226h152M180 286h152M180 346h96" stroke="#2c6e69" stroke-width="20" stroke-linecap="round"/>
  </g>
</svg>
`;

await mkdir('icons', { recursive: true });
await writeFile('icons/icon.svg', svg);
await writeFile('icons/icon-192.png', png(192, {}));
await writeFile('icons/icon-512.png', png(512, {}));
await writeFile('icons/icon-maskable-512.png', png(512, { maskable: true }));
await writeFile('icons/apple-touch-icon.png', png(180, { maskable: true }));
console.log('icons written');
