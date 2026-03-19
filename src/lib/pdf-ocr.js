import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PSM, createWorker } from 'tesseract.js';
import { applyOutlineTree, countOutlineItems, extractOutlineTree } from './outline.js';

const PDF_WORKER_URL = chrome.runtime.getURL('assets/pdfjs/pdf.worker.mjs');
const OCR_WORKER_URL = chrome.runtime.getURL('assets/tesseract/worker.min.js');
const OCR_CORE_URL = chrome.runtime.getURL('assets/tesseract-core');
const OCR_LANG_URL = chrome.runtime.getURL('assets/tessdata');
const DEFAULT_OCR_PARALLELISM = 2;
const MAX_OCR_PARALLELISM = 3;
let pdfjsLibPromise;

function clampParallelism(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_OCR_PARALLELISM;
  }

  return Math.max(1, Math.min(MAX_OCR_PARALLELISM, Math.floor(numeric)));
}

function defineCompatMethod(target, name, implementation) {
  if (typeof target?.[name] === 'function') {
    return;
  }

  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: implementation,
  });
}

function ensurePdfJsCompat() {
  defineCompatMethod(Map.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callbackfn) {
    if (this.has(key)) {
      return this.get(key);
    }

    const value = callbackfn(key);
    this.set(key, value);
    return value;
  });

  defineCompatMethod(WeakMap.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callbackfn) {
    if (this.has(key)) {
      return this.get(key);
    }

    const value = callbackfn(key);
    this.set(key, value);
    return value;
  });
}

async function getPdfJsLib() {
  if (!pdfjsLibPromise) {
    ensurePdfJsCompat();
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return pdfjsLib;
    });
  }

  return pdfjsLibPromise;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeProgress(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizePageMode(value) {
  const knownModes = new Set([
    'UseNone',
    'UseOutlines',
    'UseThumbs',
    'FullScreen',
    'UseOC',
    'UseAttachments',
  ]);

  return knownModes.has(value) ? value : 'UseOutlines';
}

async function renderPdfPage(page, viewport) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) {
    throw new Error('Nao foi possivel obter o contexto 2D para renderizar o PDF.');
  }

  context.save();
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const renderTask = page.render({
    canvasContext: context,
    viewport,
  });

  await renderTask.promise;

  return canvas;
}

function cleanupCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

function normalizeRecognizedPageText(recognitionData) {
  const paragraphText = (recognitionData?.paragraphs || [])
    .map((paragraph) => paragraph.text?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean)
    .join('\n\n');

  const rawText = paragraphText || recognitionData?.text || '';

  return rawText
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function hasUsefulRecognizedText(text) {
  const compact = (text || '').replace(/\s+/g, '');
  return compact.length >= 12;
}

function wrapTextToLines(text, font, fontSize, maxWidth) {
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      const candidateWidth = font.widthOfTextAtSize(candidate, fontSize);

      if (candidateWidth <= maxWidth || !currentLine) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    lines.push('');
  }

  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function paginateTextLines(lines, pageHeight, topMargin, bottomMargin, lineHeight) {
  const usableHeight = Math.max(1, pageHeight - topMargin - bottomMargin);
  const linesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));
  const pages = [];

  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }

  return pages.length ? pages : [[]];
}

function createTextOnlyPages({ outputPdf, sourcePageSize, text, font }) {
  const width = sourcePageSize.width;
  const height = sourcePageSize.height;
  const marginX = Math.max(36, width * 0.07);
  const marginTop = Math.max(42, height * 0.07);
  const marginBottom = Math.max(42, height * 0.07);
  const fontSize = Math.min(12, Math.max(10, width / 55));
  const lineHeight = fontSize * 1.45;
  const maxWidth = width - marginX * 2;
  const normalizedText = hasUsefulRecognizedText(text)
    ? text
    : '[Sem texto suficiente detectado nesta pagina]';
  const wrappedLines = wrapTextToLines(normalizedText, font, fontSize, maxWidth);
  const pageLineGroups = paginateTextLines(
    wrappedLines,
    height,
    marginTop,
    marginBottom,
    lineHeight,
  );
  const createdPages = [];

  for (const pageLines of pageLineGroups) {
    const outputPage = outputPdf.addPage([width, height]);
    let y = height - marginTop;

    outputPage.drawText(pageLines.join('\n'), {
      x: marginX,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
      lineHeight,
      maxWidth,
      wordBreaks: [' ', '-'],
    });

    createdPages.push(outputPage);
  }

  return {
    createdPages,
    hasUsefulText: hasUsefulRecognizedText(text),
  };
}

async function createOcrWorker(language, onProgress) {
  const worker = await createWorker(language, 1, {
    corePath: OCR_CORE_URL,
    langPath: OCR_LANG_URL,
    workerBlobURL: false,
    workerPath: OCR_WORKER_URL,
    logger(message) {
      onProgress?.({
        phase: 'ocr-engine',
        progress: sanitizeProgress(message.progress),
        detail: message.status || 'Preparando OCR',
      });
    },
  });

  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: String(PSM.AUTO),
  });

  return worker;
}

async function processSourcePage({
  sourcePdf,
  pageNumber,
  totalPages,
  renderScale,
  worker,
  workerLabel,
  onProgress,
}) {
  const page = await sourcePdf.getPage(pageNumber);
  const pdfViewport = page.getViewport({ scale: 1 });
  const renderViewport = page.getViewport({ scale: renderScale });

  onProgress?.({
    phase: 'render-page',
    pageNumber,
    totalPages,
    detail: `Renderizando pagina ${pageNumber} no worker ${workerLabel}`,
  });

  const canvas = await renderPdfPage(page, renderViewport);

  try {
    onProgress?.({
      phase: 'ocr-page',
      pageNumber,
      totalPages,
      detail: `Executando OCR na pagina ${pageNumber} no worker ${workerLabel}`,
    });

    const recognition = await worker.recognize(canvas);

    return {
      index: pageNumber - 1,
      pageNumber,
      sourcePageSize: pdfViewport,
      recognizedText: normalizeRecognizedPageText(recognition.data),
    };
  } finally {
    cleanupCanvas(canvas);
    page.cleanup?.();
  }
}

export async function createSearchablePdf({
  inputBytes,
  language = 'por+eng',
  parallelism = DEFAULT_OCR_PARALLELISM,
  renderScale = 2,
  onProgress,
}) {
  const startTime = performance.now();
  const pdfjsLib = await getPdfJsLib();
  const loadingTask = pdfjsLib.getDocument({
    data: inputBytes,
  });

  let workers = [];
  let sourcePdf = null;

  onProgress?.({
    phase: 'loading',
    progress: 0.02,
    detail: 'Lendo PDF original',
  });

  try {
    sourcePdf = await loadingTask.promise;

    const [outlineItems, originalPageMode] = await Promise.all([
      extractOutlineTree(sourcePdf).catch(() => []),
      sourcePdf.getPageMode().catch(() => null),
    ]);

    const outputPdf = await PDFDocument.create();
    const ocrFont = await outputPdf.embedFont(StandardFonts.Helvetica);

    const pageRefsByIndex = [];
    const totalPages = sourcePdf.numPages;
    let textSourcePageCount = 0;
    let emptySourcePageCount = 0;
    let ocrElapsedMs = 0;
    const pageResults = new Array(totalPages);
    const workerCount = Math.min(clampParallelism(parallelism), totalPages);
    let nextPageNumber = 1;
    let processedPages = 0;

    onProgress?.({
      phase: 'loading',
      progress: 0.08,
      detail: `${totalPages} pagina(s) carregada(s), OCR em ate ${workerCount} pagina(s) em paralelo`,
    });

    workers = await Promise.all(
      Array.from({ length: workerCount }, (_, workerIndex) =>
        createOcrWorker(language, (update) => {
          onProgress?.(update);
        }),
      ),
    );

    const ocrStartTime = performance.now();
    await Promise.all(
      workers.map(async (worker, workerIndex) => {
        const workerLabel = workerIndex + 1;

        while (nextPageNumber <= totalPages) {
          const pageNumber = nextPageNumber;
          nextPageNumber += 1;

          onProgress?.({
            phase: 'page-start',
            pageNumber,
            totalPages,
            progress: 0.08 + ((pageNumber - 1) / totalPages) * 0.5,
            detail: `Processando pagina ${pageNumber} de ${totalPages} no worker ${workerLabel}`,
          });

          const result = await processSourcePage({
            sourcePdf,
            pageNumber,
            totalPages,
            renderScale,
            worker,
            workerLabel,
            onProgress,
          });

          pageResults[result.index] = result;
          processedPages += 1;

          onProgress?.({
            phase: 'ocr-page',
            pageNumber,
            totalPages,
            progress: 0.12 + (processedPages / totalPages) * 0.6,
            detail: `OCR concluido em ${processedPages} de ${totalPages} pagina(s)`,
          });
        }
      }),
    );
    ocrElapsedMs = Math.round(performance.now() - ocrStartTime);

    for (const result of pageResults) {
      const index = result.index;

      onProgress?.({
        phase: 'build-page',
        pageNumber: result.pageNumber,
        totalPages,
        progress: 0.75 + ((index + 1) / totalPages) * 0.18,
        detail: `Montando pagina textual ${result.pageNumber} no PDF final`,
      });

      const { createdPages, hasUsefulText } = createTextOnlyPages({
        outputPdf,
        sourcePageSize: result.sourcePageSize,
        text: result.recognizedText,
        font: ocrFont,
      });

      pageRefsByIndex[index] = createdPages[0].ref;

      if (hasUsefulText) {
        textSourcePageCount += 1;
      } else {
        emptySourcePageCount += 1;
      }

      await sleep(0);
    }

    onProgress?.({
      phase: 'finalize',
      progress: 0.95,
      detail: 'Aplicando outline e finalizando o PDF',
    });

    const outlinePreserved = applyOutlineTree(
      outputPdf,
      outlineItems,
      pageRefsByIndex,
      normalizePageMode(originalPageMode),
    );

    const bytes = await outputPdf.save();
    const elapsedMs = Math.round(performance.now() - startTime);

    onProgress?.({
      phase: 'done',
      progress: 1,
      detail: 'PDF OCR concluido',
    });

    return {
      bytes,
      meta: {
        elapsedMs,
        ocrElapsedMs,
        textSourcePageCount,
        emptySourcePageCount,
        outlineItemCount: countOutlineItems(outlineItems),
        outlinePreserved,
        pageCount: totalPages,
        parallelismUsed: workerCount,
        outputPageCount: outputPdf.getPageCount(),
      },
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));

    sourcePdf?.cleanup?.();
    await loadingTask.destroy();
  }
}
