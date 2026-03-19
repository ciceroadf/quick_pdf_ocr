import {
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

function roundNumber(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeColor(color) {
  if (!color || color.length < 3) {
    return null;
  }

  return [roundNumber(color[0] / 255), roundNumber(color[1] / 255), roundNumber(color[2] / 255)];
}

function normalizeDestinationMode(mode) {
  if (mode && typeof mode === 'object' && typeof mode.name === 'string') {
    return mode.name;
  }

  return 'Fit';
}

function normalizeDestinationParams(values) {
  return values.map((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return roundNumber(value);
    }

    return null;
  });
}

async function resolveDestinationPageIndex(pdfDocument, pageReference) {
  if (Number.isInteger(pageReference)) {
    return pageReference;
  }

  if (pageReference && typeof pageReference === 'object') {
    try {
      return await pdfDocument.getPageIndex(pageReference);
    } catch {
      return null;
    }
  }

  return null;
}

async function normalizeOutlineDestination(pdfDocument, item) {
  if (item.url) {
    return {
      type: 'uri',
      url: item.url,
    };
  }

  let destination = item.dest;

  if (typeof destination === 'string') {
    try {
      destination = await pdfDocument.getDestination(destination);
    } catch {
      destination = null;
    }
  }

  if (!Array.isArray(destination) || destination.length < 2) {
    return null;
  }

  const pageIndex = await resolveDestinationPageIndex(pdfDocument, destination[0]);
  if (pageIndex === null) {
    return null;
  }

  return {
    type: 'internal',
    pageIndex,
    mode: normalizeDestinationMode(destination[1]),
    params: normalizeDestinationParams(destination.slice(2)),
  };
}

async function normalizeOutlineItem(pdfDocument, item) {
  const children = await Promise.all(
    (item.items || []).map((child) => normalizeOutlineItem(pdfDocument, child)),
  );

  return {
    title: item.title?.trim() || 'Sem titulo',
    bold: Boolean(item.bold),
    italic: Boolean(item.italic),
    color: normalizeColor(item.color),
    isOpen: typeof item.count === 'number' ? item.count >= 0 : true,
    destination: await normalizeOutlineDestination(pdfDocument, item),
    items: children,
  };
}

function countAllNodes(items) {
  return items.reduce((total, item) => total + 1 + countAllNodes(item.items), 0);
}

function countDescendants(item) {
  return countAllNodes(item.items);
}

function countVisibleNodes(items) {
  return items.reduce((total, item) => {
    const visibleChildren = item.isOpen ? countVisibleNodes(item.items) : 0;
    return total + 1 + visibleChildren;
  }, 0);
}

function attachDestination(dict, context, destination, pageRefsByIndex) {
  if (!destination) {
    return;
  }

  if (destination.type === 'uri' && destination.url) {
    dict.set(
      PDFName.of('A'),
      context.obj({
        S: 'URI',
        URI: PDFString.of(destination.url),
      }),
    );
    return;
  }

  if (destination.type !== 'internal') {
    return;
  }

  const pageRef = pageRefsByIndex[destination.pageIndex];
  if (!pageRef) {
    return;
  }

  const destinationArray = context.obj([
    pageRef,
    destination.mode || 'Fit',
    ...(destination.params || []).map((value) => (value === null ? PDFNull : value)),
  ]);

  dict.set(PDFName.of('Dest'), destinationArray);
}

function createOutlineLevel(context, parentRef, items, pageRefsByIndex) {
  if (!items.length) {
    return [];
  }

  const refs = items.map(() => context.nextRef());

  items.forEach((item, index) => {
    const ref = refs[index];
    const dict = context.obj({
      Title: PDFHexString.fromText(item.title),
      Parent: parentRef,
    });

    if (index > 0) {
      dict.set(PDFName.of('Prev'), refs[index - 1]);
    }

    if (index < refs.length - 1) {
      dict.set(PDFName.of('Next'), refs[index + 1]);
    }

    const fontFlags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
    if (fontFlags) {
      dict.set(PDFName.of('F'), PDFNumber.of(fontFlags));
    }

    if (item.color) {
      dict.set(PDFName.of('C'), context.obj(item.color));
    }

    attachDestination(dict, context, item.destination, pageRefsByIndex);

    const childRefs = createOutlineLevel(context, ref, item.items, pageRefsByIndex);
    if (childRefs.length) {
      dict.set(PDFName.of('First'), childRefs[0]);
      dict.set(PDFName.of('Last'), childRefs[childRefs.length - 1]);

      const descendantCount = countDescendants(item);
      dict.set(PDFName.of('Count'), PDFNumber.of(item.isOpen ? descendantCount : -descendantCount));
    }

    context.assign(ref, dict);
  });

  return refs;
}

export async function extractOutlineTree(pdfDocument) {
  const outline = await pdfDocument.getOutline();

  if (!outline?.length) {
    return [];
  }

  return Promise.all(outline.map((item) => normalizeOutlineItem(pdfDocument, item)));
}

export function applyOutlineTree(pdfDoc, outlineItems, pageRefsByIndex, pageMode = 'UseOutlines') {
  if (!outlineItems?.length) {
    return false;
  }

  const { context, catalog } = pdfDoc;
  const rootRef = context.register(context.obj({ Type: 'Outlines' }));
  const rootDict = context.lookup(rootRef);
  const topLevelRefs = createOutlineLevel(context, rootRef, outlineItems, pageRefsByIndex);

  if (!topLevelRefs.length) {
    return false;
  }

  rootDict.set(PDFName.of('First'), topLevelRefs[0]);
  rootDict.set(PDFName.of('Last'), topLevelRefs[topLevelRefs.length - 1]);
  rootDict.set(PDFName.of('Count'), PDFNumber.of(countVisibleNodes(outlineItems)));

  catalog.set(PDFName.of('Outlines'), rootRef);
  catalog.set(PDFName.of('PageMode'), PDFName.of(pageMode || 'UseOutlines'));

  return true;
}

export function countOutlineItems(outlineItems) {
  return countAllNodes(outlineItems);
}
