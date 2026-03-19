import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

function makeCrcTable() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }

  return table;
}

const crcTable = makeCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;

  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * stride, y * stride + stride);
  }

  const compressed = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mixColor(left, right, ratio) {
  return [
    Math.round(left[0] + (right[0] - left[0]) * ratio),
    Math.round(left[1] + (right[1] - left[1]) * ratio),
    Math.round(left[2] + (right[2] - left[2]) * ratio),
    Math.round(left[3] + (right[3] - left[3]) * ratio),
  ];
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLengthSquared = abx * abx + aby * aby;
  const t = abLengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLengthSquared));
  const closestX = ax + abx * t;
  const closestY = ay + aby * t;
  const dx = px - closestX;
  const dy = py - closestY;
  return Math.sqrt(dx * dx + dy * dy);
}

function buildIconGrid() {
  const gridSize = 32;
  const pixels = new Uint8ClampedArray(gridSize * gridSize * 4);
  const centerX = 15.5;
  const centerY = 14.5;
  const bgStart = [29, 36, 51, 255];
  const bgEnd = [8, 11, 18, 255];
  const qStart = [138, 74, 22, 255];
  const qMid = [184, 106, 38, 255];
  const qEnd = [225, 183, 94, 255];
  const sparkle = [107, 144, 171, 255];

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const bgMix = Math.min(1, radius / 19);
      let color = mixColor(bgStart, bgEnd, bgMix);

      const inOuterRing = radius <= 11.7;
      const inInnerHole = radius < 6.6;
      const topFlat = y < 4 && Math.abs(dx) < 2.4;
      const qTail = pointToSegmentDistance(x + 0.5, y + 0.5, 19.5, 21, 27.3, 28.3) < 2.3;
      const innerCut = x > 15 && y > 16 && pointToSegmentDistance(x + 0.5, y + 0.5, 18.3, 17.2, 23.4, 22.1) < 2.8;
      const isQ = (inOuterRing && !inInnerHole) || topFlat || qTail;

      if (isQ && !innerCut) {
        const gradientA = mixColor(qStart, qMid, Math.min(1, (x + y) / 34));
        color = mixColor(gradientA, qEnd, Math.min(1, x / 31));
      }

      const sparklePoints = new Set(['26,4', '27,5', '26,6', '25,5']);
      if (sparklePoints.has(`${x},${y}`)) {
        color = sparkle;
      }

      const offset = (y * gridSize + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }

  return { gridSize, pixels };
}

function upscaleNearestNeighbor(gridPixels, gridSize, size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(gridSize - 1, Math.floor((y / size) * gridSize));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(gridSize - 1, Math.floor((x / size) * gridSize));
      const sourceOffset = (sourceY * gridSize + sourceX) * 4;
      const targetOffset = (y * size + x) * 4;

      pixels[targetOffset] = gridPixels[sourceOffset];
      pixels[targetOffset + 1] = gridPixels[sourceOffset + 1];
      pixels[targetOffset + 2] = gridPixels[sourceOffset + 2];
      pixels[targetOffset + 3] = gridPixels[sourceOffset + 3];
    }
  }

  return pixels;
}

async function generateIcons() {
  const iconDir = path.join(distDir, 'assets', 'icons');
  await mkdir(iconDir, { recursive: true });

  const { gridSize, pixels } = buildIconGrid();
  const sizes = [16, 32, 48, 128];

  await Promise.all(
    sizes.map(async (size) => {
      const scaled = upscaleNearestNeighbor(pixels, gridSize, size);
      const png = encodePng(size, size, scaled);
      await writeFile(path.join(iconDir, `icon${size}.png`), png);
    }),
  );
}

async function copyFile(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
}

async function copyStaticAssets() {
  await Promise.all([
    copyFile(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json')),
    copyFile(path.join(srcDir, 'app.html'), path.join(distDir, 'app.html')),
    copyFile(path.join(srcDir, 'styles.css'), path.join(distDir, 'styles.css')),
    copyFile(
      path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
      path.join(distDir, 'assets', 'pdfjs', 'pdf.worker.mjs'),
    ),
    copyFile(
      path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
      path.join(distDir, 'assets', 'tesseract', 'worker.min.js'),
    ),
    copyFile(
      path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js.LICENSE.txt'),
      path.join(distDir, 'assets', 'tesseract', 'worker.min.js.LICENSE.txt'),
    ),
    copyFile(
      path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0', 'eng.traineddata.gz'),
      path.join(distDir, 'assets', 'tessdata', 'eng.traineddata.gz'),
    ),
    copyFile(
      path.join(root, 'node_modules', '@tesseract.js-data', 'por', '4.0.0', 'por.traineddata.gz'),
      path.join(distDir, 'assets', 'tessdata', 'por.traineddata.gz'),
    ),
    copyFile(
      path.join(
        root,
        'node_modules',
        '@fontsource-variable',
        'source-sans-3',
        'files',
        'source-sans-3-latin-ext-wght-normal.woff2',
      ),
      path.join(distDir, 'assets', 'fonts', 'source-sans-3-latin-ext-wght-normal.woff2'),
    ),
  ]);

  const tesseractCoreDir = path.join(root, 'node_modules', 'tesseract.js-core');
  const targetCoreDir = path.join(distDir, 'assets', 'tesseract-core');
  await mkdir(targetCoreDir, { recursive: true });

  const coreFiles = [
    'tesseract-core.js',
    'tesseract-core.wasm',
    'tesseract-core.wasm.js',
    'tesseract-core-lstm.js',
    'tesseract-core-lstm.wasm',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd.js',
    'tesseract-core-simd.wasm',
    'tesseract-core-simd.wasm.js',
    'tesseract-core-simd-lstm.js',
    'tesseract-core-simd-lstm.wasm',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd.js',
    'tesseract-core-relaxedsimd.wasm',
    'tesseract-core-relaxedsimd.wasm.js',
    'tesseract-core-relaxedsimd-lstm.js',
    'tesseract-core-relaxedsimd-lstm.wasm',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ];

  await Promise.all(
    coreFiles.map((file) => copyFile(path.join(tesseractCoreDir, file), path.join(targetCoreDir, file))),
  );
}

async function writePackageStub() {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const distPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
  };

  await writeFile(path.join(distDir, 'package.json'), JSON.stringify(distPackageJson, null, 2));
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: {
    app: path.join(srcDir, 'app.js'),
    background: path.join(srcDir, 'background.js'),
  },
  format: 'esm',
  minify: false,
  outdir: distDir,
  platform: 'browser',
  sourcemap: false,
  target: ['chrome120'],
});

await copyStaticAssets();
await generateIcons();
await writePackageStub();

console.log(`Build concluido em ${distDir}`);
