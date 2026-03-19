# Quick PDF OCR

Quick PDF OCR is a Chrome extension that runs OCR locally on PDF files and generates a searchable text-based PDF while trying to preserve the original outline/bookmarks.

## Features

- local OCR in the browser with `tesseract.js`
- searchable text-only PDF output
- optional parallel OCR processing with configurable concurrency
- attempts to preserve PDF outline/bookmarks from the source file
- no server upload required for processing

## How It Works

1. the original PDF is opened with `pdf.js`
2. each page is rendered in the browser
3. OCR is executed locally with `tesseract.js`
4. a new PDF is generated with `pdf-lib`
5. if the source PDF contains an outline, the extension tries to rebuild it in the output file

## Current Behavior

- the output PDF is text-based and searchable
- the original scanned visual layout is not preserved
- documents with tables, multi-column layouts, forms, or handwriting may need further layout improvements
- OCR quality depends on scan quality, language, and rendering scale

## Installation

1. install dependencies:

```bash
npm install
```

2. build the extension:

```bash
npm run build
```

3. open `chrome://extensions`
4. enable `Developer mode`
5. click `Load unpacked`
6. select the `dist` folder

## Usage

1. open the extension
2. select a PDF file
3. choose OCR language, render scale, and parallelism
4. click `Gerar PDF OCR`
5. download the generated `*-ocr.pdf`

## Tech Stack

- `pdfjs-dist`
- `tesseract.js`
- `pdf-lib`
- `esbuild`

## Limitations

- outline/bookmark preservation is best-effort
- advanced PDF actions may not be preserved
- the generated document is optimized for searchable text, not faithful visual reproduction
- large PDFs can consume significant CPU and memory

## Author

Made by Cicero Alves Duarte Filho

GitHub: https://github.com/ciceroadf
