import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

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
await writePackageStub();

console.log(`Build concluido em ${distDir}`);
