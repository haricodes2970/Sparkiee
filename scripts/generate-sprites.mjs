#!/usr/bin/env node
/**
 * Procedural sprite-sheet generator for the original Sparkiee starter
 * character. Every pixel is drawn from scratch by this script — no external
 * art is traced, copied, or derived from any existing character. Output is
 * committed so installs never need a build step.
 *
 * Usage: node scripts/generate-sprites.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../assets/characters/sparkiee-original/sprites/', import.meta.url));
const FRAME = 32;
const COLUMNS = 8;

// ---------------------------------------------------------------------------
// Minimal RGBA raster + PNG encoder (8-bit RGBA, no interlace)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class Grid {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  px(x, y, color) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.size || yi >= this.size) return;
    const i = (yi * this.size + xi) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = color[3];
  }

  fillEllipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, color);
      }
    }
  }

  fillRect(x, y, w, h, color) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.px(x + i, y + j, color);
  }

  fillCircle(cx, cy, r, color) {
    this.fillEllipse(cx, cy, r, r, color);
  }
}

// ---------------------------------------------------------------------------
// Original character: a round golden electric creature with a curled teal
// tuft, swirl tail, and amber cheeks. Designed from scratch for Sparkiee.
// ---------------------------------------------------------------------------

const C = {
  outline: [107, 74, 31, 255],
  body: [246, 197, 49, 255],
  shade: [221, 160, 29, 255],
  light: [255, 233, 138, 255],
  belly: [255, 243, 196, 255],
  teal: [53, 196, 181, 255],
  tealLight: [127, 233, 221, 255],
  cheek: [242, 157, 73, 255],
  eye: [58, 43, 18, 255],
  white: [255, 255, 255, 255],
  spark: [255, 216, 127, 255],
  blue: [159, 216, 255, 255],
};

const DEFAULT_POSE = {
  dy: 0,
  eyes: 'open',
  mouth: 'smile',
  armL: 'down',
  armR: 'down',
  feet: 'stand',
  tuft: 0,
  tail: 0,
  extras: [],
};

function drawEyes(g, style, dy) {
  const y = 19 + dy;
  const lx = 12;
  const rx = 20;
  if (style === 'closed' || style === 'half') {
    for (const x of [lx, rx]) {
      g.fillRect(x - 1, style === 'half' ? y : y - 1, 3, 1, C.eye);
      if (style === 'half') g.fillRect(x - 1, y + 1, 1, 1, C.eye), g.fillRect(x + 1, y + 1, 1, 1, C.eye);
    }
    return;
  }
  const r = style === 'wide' ? 2.4 : style === 'droop' ? 1.9 : 1.8;
  for (const x of [lx, rx]) {
    g.fillCircle(x, style === 'droop' ? y + 1 : y, r, C.outline);
    g.fillCircle(x, style === 'droop' ? y + 1 : y, r - 0.6, C.eye);
    const gx = x - 1;
    const gy = (style === 'droop' ? y + 1 : y) - 1;
    g.px(gx, gy, C.white);
    if (style === 'wide') g.px(gx + 1, gy, C.white);
    if (style === 'up') { g.fillRect(x - 1, y - 2, 1, 1, C.white); }
    if (style === 'sideL') { g.fillRect(x - 2, y - 1, 1, 1, C.white); }
    if (style === 'sideR') { g.fillRect(x + 1, y - 1, 1, 1, C.white); }
  }
}

function drawMouth(g, style, dy) {
  const y = 22 + dy;
  if (style === 'smile') {
    g.px(15, y, C.outline); g.px(16, y + 1, C.outline); g.px(17, y, C.outline);
  } else if (style === 'open' || style === 'happy') {
    g.fillRect(15, y - 1, 3, 2, C.outline);
    if (style === 'happy') g.fillRect(15, y, 3, 1, [196, 92, 92, 255]);
  } else if (style === 'o') {
    g.fillCircle(16, y, 1.3, C.outline);
    g.px(16, y, [196, 92, 92, 255]);
  } else if (style === 'wavy') {
    g.px(14, y, C.outline); g.px(15, y + 1, C.outline); g.px(16, y, C.outline); g.px(17, y + 1, C.outline); g.px(18, y, C.outline);
  } else if (style === 'flat') {
    g.fillRect(14, y, 5, 1, C.outline);
  } else if (style === 'frown') {
    g.px(15, y + 1, C.outline); g.px(16, y, C.outline); g.px(17, y + 1, C.outline);
  }
}

function drawArm(g, side, style, dy) {
  const x = side === 'L' ? 7 : 25;
  const y = 22 + dy;
  if (style === 'up') {
    g.fillEllipse(x + (side === 'L' ? 0.5 : -0.5), y - 5, 1.6, 2.6, C.outline);
    g.fillEllipse(x + (side === 'L' ? 0.5 : -0.5), y - 5, 1, 2, C.body);
  } else if (style === 'out') {
    g.fillEllipse(x + (side === 'L' ? -1.5 : 1.5), y - 1, 2.4, 1.6, C.outline);
    g.fillEllipse(x + (side === 'L' ? -1.5 : 1.5), y - 1, 1.8, 1, C.body);
  } else if (style === 'wave') {
    const wave = side === 'R' ? 1 : 0;
    g.fillEllipse(x - 1 + wave, y - 6, 1.6, 2.4, C.outline);
    g.fillEllipse(x - 1 + wave, y - 6, 1, 1.8, C.body);
  } else {
    g.fillEllipse(x, y + 1, 1.7, 2.2, C.outline);
    g.fillEllipse(x, y + 1, 1.1, 1.6, C.body);
  }
}

function drawFeet(g, style, dy) {
  const y = 29 + dy;
  if (style === 'stepL') {
    g.fillEllipse(11, y, 2.4, 1.6, C.outline); g.fillEllipse(11, y, 1.8, 1, C.body);
    g.fillEllipse(20, y - 1, 2, 1.4, C.outline); g.fillEllipse(20, y - 1, 1.4, 0.8, C.shade);
  } else if (style === 'stepR') {
    g.fillEllipse(21, y, 2.4, 1.6, C.outline); g.fillEllipse(21, y, 1.8, 1, C.body);
    g.fillEllipse(12, y - 1, 2, 1.4, C.outline); g.fillEllipse(12, y - 1, 1.4, 0.8, C.shade);
  } else if (style === 'tuck') {
    g.fillEllipse(13, y - 1, 2, 1.3, C.outline); g.fillEllipse(13, y - 1, 1.4, 0.8, C.body);
    g.fillEllipse(19, y - 1, 2, 1.3, C.outline); g.fillEllipse(19, y - 1, 1.4, 0.8, C.body);
  } else {
    g.fillEllipse(12.5, y, 2.4, 1.7, C.outline); g.fillEllipse(12.5, y, 1.8, 1.1, C.body);
    g.fillEllipse(19.5, y, 2.4, 1.7, C.outline); g.fillEllipse(19.5, y, 1.8, 1.1, C.body);
  }
}

function drawCharacter(pose) {
  const p = { ...DEFAULT_POSE, ...pose };
  const g = new Grid(FRAME);
  const dy = p.dy;

  // tail (behind body)
  const tailY = 20 + dy + p.tail;
  g.fillRect(23, tailY + 2, 2, 1, C.teal);
  g.fillCircle(27, tailY, 2.6, C.teal);
  g.fillCircle(27, tailY, 1.2, C.tealLight);

  // body
  g.fillEllipse(16, 21 + dy, 9, 8.4, C.outline);
  g.fillEllipse(16, 21 + dy, 8.2, 7.6, C.body);
  g.fillEllipse(14, 17 + dy, 4.5, 3, C.light);
  g.fillEllipse(16, 24.5 + dy, 5.5, 4, C.belly);
  g.fillEllipse(21, 25 + dy, 3.5, 2.5, C.shade);

  // tuft (curled antenna)
  const tx = p.tuft;
  const ty = 12 + dy;
  g.px(16 + tx, ty + 1, C.outline);
  g.px(16 + tx, ty, C.teal);
  g.px(17 + tx, ty - 1, C.teal);
  g.px(18 + tx, ty, C.tealLight);
  g.px(17 + tx, ty + 1, C.teal);
  g.px(15 + tx, ty, C.outline);
  g.px(18 + tx, ty + 1, C.outline);
  g.px(16 + tx, ty - 1, C.outline);
  g.px(19 + tx, ty, C.outline);
  g.px(17 + tx, ty - 2, C.outline);

  // face
  drawEyes(g, p.eyes, dy);
  drawMouth(g, p.mouth, dy);
  g.fillEllipse(8.5, 22.5 + dy, 2, 1.3, C.cheek);
  g.fillEllipse(23.5, 22.5 + dy, 2, 1.3, C.cheek);

  drawArm(g, 'L', p.armL, dy);
  drawArm(g, 'R', p.armR, dy);
  drawFeet(g, p.feet, dy);

  for (const extra of p.extras) extra(g, dy);
  return g;
}

// ---------------------------------------------------------------------------
// Extra effect helpers
// ---------------------------------------------------------------------------

const sparkle = (x, y, color = C.spark) => (g) => {
  g.px(x, y, color);
  g.px(x - 1, y, color); g.px(x + 1, y, color);
  g.px(x, y - 1, color); g.px(x, y + 1, color);
};

const zed = (x, y) => (g) => {
  g.fillRect(x, y, 2, 1, C.blue);
  g.px(x + 1, y + 1, C.blue);
  g.px(x, y + 2, C.blue);
  g.fillRect(x, y + 3, 2, 1, C.blue);
};

const note = (x, y) => (g) => {
  g.fillRect(x, y, 1, 4, C.spark);
  g.fillRect(x + 1, y, 2, 1, C.spark);
  g.fillCircle(x, y + 4, 1.2, C.spark);
};

const bang = (x, y) => (g) => {
  g.fillRect(x, y, 1, 3, C.spark);
  g.px(x, y + 4, C.spark);
};

const question = (x, y) => (g) => {
  g.fillRect(x, y, 2, 1, C.blue);
  g.px(x + 2, y + 1, C.blue);
  g.px(x + 1, y + 2, C.blue);
  g.px(x + 1, y + 4, C.blue);
};

const dots = (x, y) => (g) => {
  g.px(x, y, C.blue); g.px(x + 3, y - 2, C.blue); g.px(x + 6, y - 4, C.blue);
};

const check = (x, y) => (g) => {
  g.px(x, y + 2, C.teal); g.px(x + 1, y + 3, C.teal);
  g.fillRect(x + 2, y, 1, 2, C.teal); g.px(x + 3, y - 1, C.teal); g.px(x + 4, y - 2, C.teal);
};

const sweat = (x, y) => (g) => {
  g.fillCircle(x, y, 1.4, C.blue);
  g.px(x, y - 2, C.blue);
};

const speedline = (y) => (g) => {
  g.fillRect(2, y, 4, 1, C.white);
  g.fillRect(1, y + 3, 3, 1, C.white);
};

const star = (x, y) => (g) => {
  g.px(x, y, C.white);
  g.px(x - 1, y, C.spark); g.px(x + 1, y, C.spark);
  g.px(x, y - 1, C.spark); g.px(x, y + 1, C.spark);
};

// ---------------------------------------------------------------------------
// Animation frame tables
// ---------------------------------------------------------------------------

const frames = [];
function push(pose) { frames.push(drawCharacter(pose)); }

// idle (4): gentle bounce + blink
push({ dy: 0 });
push({ dy: -1, tuft: 1, tail: -1 });
push({ dy: -1, eyes: 'closed', mouth: 'smile', tuft: 1 });
push({ dy: 0, tuft: -1, tail: 1 });

// wave (4): friendly greeting
push({ armR: 'up', mouth: 'happy', extras: [sparkle(27, 10)] });
push({ armR: 'wave', mouth: 'happy', eyes: 'half' });
push({ armR: 'up', mouth: 'happy', tuft: 1 });
push({ armR: 'wave', mouth: 'happy', extras: [sparkle(6, 12, C.tealLight)] });

// walk (6): synchronised with real window movement
push({ dy: 0, feet: 'stepL', armR: 'out', eyes: 'open' });
push({ dy: -1, feet: 'stand', armL: 'out' });
push({ dy: -2, feet: 'stepR', armR: 'out', tuft: 1 });
push({ dy: -1, feet: 'stand', armL: 'out' });
push({ dy: 0, feet: 'stepL', armR: 'out', mouth: 'smile' });
push({ dy: 1, feet: 'stand', tuft: -1 });

// run (6): energetic zoomies
push({ dy: -1, feet: 'stepL', armR: 'out', eyes: 'wide', mouth: 'open', extras: [speedline(16)] });
push({ dy: -2, feet: 'stepR', armL: 'out', eyes: 'wide', mouth: 'open', tuft: 1, extras: [speedline(14)] });
push({ dy: -3, feet: 'stepL', armR: 'out', eyes: 'wide', mouth: 'happy', tail: -2, extras: [speedline(12), sparkle(28, 8)] });
push({ dy: -2, feet: 'stepR', armL: 'out', eyes: 'wide', mouth: 'open', tuft: -1, extras: [speedline(15)] });
push({ dy: -1, feet: 'stepL', armR: 'out', eyes: 'wide', mouth: 'open', extras: [speedline(13)] });
push({ dy: 0, feet: 'stand', eyes: 'open', mouth: 'happy' });

// dance (6): looping groove with notes
push({ dy: 0, armL: 'up', armR: 'up', tuft: 1, mouth: 'happy' });
push({ dy: -1, armL: 'out', armR: 'up', tuft: -1, eyes: 'closed', extras: [note(27, 10)] });
push({ dy: 0, armL: 'up', armR: 'out', mouth: 'open', extras: [note(4, 12)] });
push({ dy: -1, armL: 'up', armR: 'up', tuft: 1, eyes: 'closed', mouth: 'happy' });
push({ dy: 0, armL: 'out', armR: 'up', tuft: -1, mouth: 'open', extras: [note(28, 13, C.tealLight)] });
push({ dy: -1, armL: 'up', armR: 'out', eyes: 'half', mouth: 'happy', extras: [note(3, 10)] });

// sleep (4): drowsy with rising z's
push({ dy: 2, eyes: 'closed', mouth: 'flat', feet: 'tuck', extras: [zed(24, 12)] });
push({ dy: 2, eyes: 'closed', mouth: 'flat', feet: 'tuck', tuft: -1, extras: [zed(26, 9)] });
push({ dy: 2, eyes: 'closed', mouth: 'flat', feet: 'tuck', extras: [zed(27, 6)] });
push({ dy: 2, eyes: 'closed', mouth: 'smile', feet: 'tuck', tuft: 1, extras: [zed(25, 10)] });

// surprised (2)
push({ dy: -2, eyes: 'wide', mouth: 'o', armL: 'out', armR: 'out', extras: [bang(16, 4)] });
push({ dy: 1, eyes: 'wide', mouth: 'o', feet: 'tuck', extras: [bang(16, 3)] });

// confused (3)
push({ eyes: 'sideL', mouth: 'wavy', tuft: -1, extras: [question(24, 6)] });
push({ eyes: 'sideR', mouth: 'wavy', tuft: 1, extras: [question(25, 7)] });
push({ eyes: 'sideL', mouth: 'flat', extras: [question(24, 5)] });

// thinking (3)
push({ eyes: 'up', mouth: 'flat', tuft: 1, extras: [dots(22, 8)] });
push({ eyes: 'up', mouth: 'flat', extras: [dots(23, 6)] });
push({ eyes: 'up', mouth: 'smile', tuft: -1, extras: [dots(24, 4)] });

// celebrate (6): jumping with stars
push({ dy: -3, armL: 'up', armR: 'up', eyes: 'closed', mouth: 'happy', extras: [star(5, 10), star(27, 9)] });
push({ dy: -5, armL: 'up', armR: 'up', eyes: 'wide', mouth: 'open', extras: [star(4, 8), star(28, 12), sparkle(16, 5, C.tealLight)] });
push({ dy: -3, armL: 'out', armR: 'up', eyes: 'closed', mouth: 'happy', extras: [star(28, 7)] });
push({ dy: 0, armL: 'up', armR: 'out', mouth: 'happy', extras: [star(5, 12)] });
push({ dy: -4, armL: 'up', armR: 'up', eyes: 'wide', mouth: 'open', tuft: 1, extras: [star(6, 7), star(26, 6), sparkle(28, 14)] });
push({ dy: -1, armL: 'up', armR: 'up', eyes: 'closed', mouth: 'happy', extras: [star(16, 4, C.tealLight)] });

// task_complete (6): happy result
push({ dy: 0, armR: 'up', mouth: 'happy', extras: [check(24, 8)] });
push({ dy: -2, armR: 'up', armL: 'out', eyes: 'closed', mouth: 'happy', extras: [check(25, 7), sparkle(6, 10)] });
push({ dy: -4, armL: 'up', armR: 'up', eyes: 'wide', mouth: 'open', extras: [check(16, 3), star(5, 9), star(27, 9)] });
push({ dy: -2, armL: 'up', armR: 'up', eyes: 'closed', mouth: 'happy', extras: [star(4, 7), star(28, 11)] });
push({ dy: 0, armL: 'up', mouth: 'happy', extras: [star(27, 6, C.tealLight)] });
push({ dy: 0, eyes: 'closed', mouth: 'happy', extras: [check(25, 9), sparkle(6, 8, C.tealLight)] });

// task_error (3): gentle concern
push({ eyes: 'droop', mouth: 'wavy', tuft: -1, extras: [sweat(25, 12)] });
push({ eyes: 'droop', mouth: 'frown', extras: [sweat(26, 13)] });
push({ eyes: 'droop', mouth: 'flat', tuft: 1, extras: [sweat(24, 11)] });

// permission_required (3): wide eyes, asking paw
push({ dy: -1, eyes: 'wide', mouth: 'o', armR: 'up', extras: [bang(23, 6)] });
push({ dy: 0, eyes: 'wide', mouth: 'o', armR: 'up', tuft: 1, extras: [bang(24, 5)] });
push({ dy: -1, eyes: 'wide', mouth: 'flat', armR: 'up', extras: [bang(23, 4)] });

// ---------------------------------------------------------------------------
// Compose sheet + write PNG
// ---------------------------------------------------------------------------

const ROWS = Math.ceil(frames.length / COLUMNS);
const sheet = new Grid(COLUMNS * FRAME);
// blit each frame grid into the sheet at its slot
for (let index = 0; index < frames.length; index += 1) {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const frame = frames[index];
  for (let y = 0; y < FRAME; y += 1) {
    for (let x = 0; x < FRAME; x += 1) {
      const si = (y * FRAME + x) * 4;
      if (frame.data[si + 3] === 0) continue;
      sheet.px(col * FRAME + x, row * FRAME + y, [
        frame.data[si], frame.data[si + 1], frame.data[si + 2], frame.data[si + 3],
      ]);
    }
  }
}

await mkdir(OUT_DIR, { recursive: true });
const png = encodePng(COLUMNS * FRAME, ROWS * FRAME, sheet.data);
await writeFile(path.join(OUT_DIR, 'sheet.png'), png);
console.log(`Wrote ${COLUMNS * FRAME}x${ROWS * FRAME} sheet with ${frames.length} frames to ${OUT_DIR}sheet.png`);
