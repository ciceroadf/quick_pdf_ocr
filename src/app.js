import { createSearchablePdf } from './lib/pdf-ocr.js';

const elements = {
  dropzone: document.querySelector('#dropzone'),
  fileInput: document.querySelector('#file-input'),
  fileMeta: document.querySelector('#file-meta'),
  languageSelect: document.querySelector('#language-select'),
  scaleSelect: document.querySelector('#scale-select'),
  parallelismSelect: document.querySelector('#parallelism-select'),
  processButton: document.querySelector('#process-button'),
  progressFill: document.querySelector('#progress-fill'),
  statusSummary: document.querySelector('#status-summary'),
  statusStep: document.querySelector('#status-step'),
  statusPercent: document.querySelector('#status-percent'),
  statusFile: document.querySelector('#status-file'),
  statusLog: document.querySelector('#status-log'),
};

const state = {
  file: null,
  busy: false,
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms)) {
    return '-';
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function buildOutputFileName(fileName) {
  const sanitizedBase = fileName.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_');
  return `${sanitizedBase || 'documento'}-ocr.pdf`;
}

function pushLog(message) {
  const item = document.createElement('li');
  item.textContent = message;
  elements.statusLog.prepend(item);

  while (elements.statusLog.children.length > 8) {
    elements.statusLog.removeChild(elements.statusLog.lastChild);
  }
}

function setProgress(value) {
  const safeValue = Math.max(0, Math.min(1, value || 0));
  elements.progressFill.style.width = `${Math.round(safeValue * 100)}%`;
  elements.statusPercent.textContent = `${Math.round(safeValue * 100)}%`;
}

function setStep(step) {
  elements.statusStep.textContent = step;
}

function setSummary(summary) {
  elements.statusSummary.textContent = summary;
}

function refreshSelectionState() {
  elements.processButton.disabled = !state.file || state.busy;
  elements.statusFile.textContent = state.file ? state.file.name : '-';

  if (!state.file) {
    elements.fileMeta.textContent = 'Nenhum arquivo selecionado.';
    return;
  }

  elements.fileMeta.textContent = `${state.file.name} | ${formatBytes(state.file.size)}`;
}

function assignFile(file) {
  const isPdf =
    file &&
    (file.type === 'application/pdf' || typeof file.name === 'string' && /\.pdf$/i.test(file.name));

  if (!isPdf) {
    pushLog('Selecione um arquivo PDF valido.');
    return;
  }

  state.file = file;
  refreshSelectionState();
  setSummary('Arquivo pronto para OCR.');
  setStep('Pronto');
  setProgress(0);
}

async function downloadPdf(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const chromeApi = globalThis.chrome;

  try {
    if (chromeApi?.downloads?.download) {
      await chromeApi.downloads.download({
        url,
        filename: fileName,
        saveAs: true,
      });
      return;
    }

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
  }
}

function describePhase(update) {
  const phaseLabels = {
    loading: 'Leitura',
    'ocr-engine': 'OCR',
    'page-start': 'Fila',
    'render-page': 'Renderizacao',
    'ocr-page': 'Reconhecimento',
    'build-page': 'Montagem',
    finalize: 'Finalizacao',
    done: 'Concluido',
  };

  return phaseLabels[update.phase] || 'Processando';
}

function summarizeProgress(update) {
  if (update.phase === 'ocr-page' && update.pageNumber && update.totalPages) {
    return `Fazendo OCR na pagina ${update.pageNumber} de ${update.totalPages}.`;
  }

  if (update.phase === 'loading') {
    return 'Preparando OCR e leitura do PDF.';
  }

  if (update.phase === 'finalize') {
    return 'Finalizando o PDF.';
  }

  if (update.phase === 'done') {
    return 'PDF OCR concluido.';
  }

  return null;
}

async function processSelectedFile() {
  if (!state.file || state.busy) {
    return;
  }

  state.busy = true;
  refreshSelectionState();
  setStep('Inicializando');
  setSummary('Preparando OCR e leitura do PDF.');
  pushLog(`Iniciando processamento de ${state.file.name}.`);

  try {
    const fileBytes = new Uint8Array(await state.file.arrayBuffer());
    const language = elements.languageSelect.value;
    const renderScale = Number(elements.scaleSelect.value);
    const parallelism = Number(elements.parallelismSelect.value);

    const result = await createSearchablePdf({
      inputBytes: fileBytes,
      language,
      parallelism,
      renderScale,
      onProgress(update) {
        if (typeof update.progress === 'number') {
          setProgress(update.progress);
        }

        setStep(describePhase(update));

        const summary = summarizeProgress(update);
        if (summary) {
          setSummary(summary);
        }
      },
    });

    const outputName = buildOutputFileName(state.file.name);
    await downloadPdf(result.bytes, outputName);

    setProgress(1);
    setStep('Concluido');
    setSummary(
      [
        `${result.meta.pageCount} pagina(s) de origem processada(s) em ${formatElapsed(result.meta.elapsedMs)}.`,
        `OCR em ${formatElapsed(result.meta.ocrElapsedMs)}.`,
        `${result.meta.outputPageCount} pagina(s) no PDF textual final.`,
        `${result.meta.textSourcePageCount} com texto util`,
        `paralelismo ${result.meta.parallelismUsed}x`,
      ].join(' '),
    );

    pushLog(
      [
        `PDF exportado como ${outputName}.`,
        `${result.meta.outputPageCount} pagina(s) foram gerada(s) no PDF final.`,
        `${result.meta.textSourcePageCount} pagina(s) de origem tiveram texto util no OCR.`,
        `Tempo de OCR: ${formatElapsed(result.meta.ocrElapsedMs)}.`,
        `OCR executado com paralelismo ${result.meta.parallelismUsed}x.`,
        result.meta.emptySourcePageCount
          ? `${result.meta.emptySourcePageCount} pagina(s) de origem ficaram com OCR fraco ou vazio.`
          : 'Todas as paginas de origem tiveram OCR util.',
        result.meta.outlinePreserved
          ? `${result.meta.outlineItemCount} item(ns) de outline reconstruido(s).`
          : 'Nenhum outline interno foi reconstruido.',
      ].join(' '),
    );
  } catch (error) {
    console.error(error);
    setStep('Erro');
    setProgress(0);
    setSummary('O processamento falhou.');
    pushLog(error instanceof Error ? error.message : 'Falha inesperada durante o OCR.');
  } finally {
    state.busy = false;
    refreshSelectionState();
  }
}

elements.dropzone.addEventListener('click', () => {
  if (!state.busy) {
    elements.fileInput.click();
  }
});

elements.dropzone.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !state.busy) {
    event.preventDefault();
    elements.fileInput.click();
  }
});

elements.fileInput.addEventListener('change', (event) => {
  assignFile(event.target.files?.[0] || null);
});

elements.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropzone.classList.add('is-dragging');
});

elements.dropzone.addEventListener('dragleave', () => {
  elements.dropzone.classList.remove('is-dragging');
});

elements.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove('is-dragging');
  assignFile(event.dataTransfer?.files?.[0] || null);
});

elements.processButton.addEventListener('click', () => {
  processSelectedFile();
});

refreshSelectionState();
