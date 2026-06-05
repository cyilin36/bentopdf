import { showLoader, hideLoader, showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { state } from '../state.js';
import { createIcons, icons } from 'lucide';
import ofdTextFontBoldUrl from '../../../node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Bold.otf?url';
import ofdTextFontLightUrl from '../../../node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Light.otf?url';
import ofdTextFontRegularUrl from '../../../node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf?url';

const EXTENSIONS = ['.ofd'];
const MM_TO_PT = 72 / 25.4;
const DEFAULT_PAGE_BOX: OfdBox = { x: 0, y: 0, width: 210, height: 297 };

type OfdBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OfdColor = {
  r: number;
  g: number;
  b: number;
  alpha: number;
};

type DrawParam = {
  id: string;
  relative?: string;
  lineWidth?: number;
  fillColor?: OfdColor;
  strokeColor?: OfdColor;
};

type FontDef = {
  id: string;
  name: string;
  family: string;
};

type MediaDef = {
  id: string;
  path: string;
  format: string;
};

type TemplateDef = {
  id: string;
  path: string;
  zOrder: string;
};

type PageDef = {
  id: string;
  path: string;
};

type OfdDocument = {
  zip: any;
  docDir: string;
  pageBox: OfdBox;
  drawParams: Map<string, DrawParam>;
  fonts: Map<string, FontDef>;
  media: Map<string, MediaDef>;
  pages: PageDef[];
  templates: Map<string, TemplateDef>;
};

type TextCode = {
  text: string;
  x: number;
  y: number;
  deltaX: number[];
};

type PdfKitDocument = {
  addPage: (options: { size: [number, number]; margin: number }) => void;
  bezierCurveTo: (
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ) => PdfKitDocument;
  closePath: () => PdfKitDocument;
  end: () => void;
  fill: () => PdfKitDocument;
  fillColor: (color: string) => PdfKitDocument;
  font: (font: string | Uint8Array) => PdfKitDocument;
  fontSize: (size: number) => PdfKitDocument;
  image: (
    src: string | Uint8Array,
    x: number,
    y: number,
    options: { width: number; height: number }
  ) => PdfKitDocument;
  lineTo: (x: number, y: number) => PdfKitDocument;
  lineWidth: (width: number) => PdfKitDocument;
  moveTo: (x: number, y: number) => PdfKitDocument;
  opacity: (opacity: number) => PdfKitDocument;
  pipe: (stream: unknown) => unknown;
  quadraticCurveTo: (
    cpx: number,
    cpy: number,
    x: number,
    y: number
  ) => PdfKitDocument;
  registerFont: (name: string, src: Uint8Array) => PdfKitDocument;
  restore: () => PdfKitDocument;
  save: () => PdfKitDocument;
  stroke: () => PdfKitDocument;
  strokeColor: (color: string) => PdfKitDocument;
  text: (
    text: string,
    x: number,
    y: number,
    options: { lineBreak: false }
  ) => PdfKitDocument;
  widthOfString: (text: string) => number;
};

type PdfKitConstructor = new (options: {
  autoFirstPage: false;
  compress: boolean;
  margin: number;
}) => PdfKitDocument;

type BlobStream = {
  on: (event: 'finish' | 'error', callback: (error?: Error) => void) => void;
  toBlob: (type: string) => Blob;
};

type OfdPdfFonts = {
  bold: Uint8Array;
  light: Uint8Array;
  regular: Uint8Array;
};

type BrowserGlobalShim = typeof globalThis & {
  global?: typeof globalThis;
};

const installPdfBrowserShims = () => {
  (globalThis as BrowserGlobalShim).global ??= globalThis;
};

const parseXml = (xml: string) => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = document.querySelector('parsererror');
  if (parserError) {
    throw new Error(parserError.textContent?.trim() || 'Invalid OFD XML.');
  }
  return document;
};

const localName = (element: Element) => element.localName || element.nodeName;

const directChildren = (element: Element | XMLDocument, name?: string) =>
  Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === Node.ELEMENT_NODE &&
      (!name || localName(node as Element) === name)
  );

const firstChild = (element: Element | XMLDocument, name: string) =>
  directChildren(element, name)[0] ?? null;

const textOf = (element: Element | XMLDocument, name: string) =>
  firstChild(element, name)?.textContent?.trim() ?? '';

const allElements = (element: Element | XMLDocument, name: string) =>
  Array.from(element.getElementsByTagNameNS('*', name));

const firstTextIn = (element: Element | XMLDocument, name: string) =>
  allElements(element, name)[0]?.textContent?.trim() ?? '';

const normalizeZipPath = (path: string) =>
  path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');

const dirname = (path: string) => {
  const normalized = normalizeZipPath(path);
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
};

const joinZipPath = (...parts: Array<string | undefined | null>) =>
  normalizeZipPath(parts.filter(Boolean).join('/'));

const resolveRelativePath = (baseDir: string, path: string) =>
  normalizeZipPath(path.startsWith('/') ? path : joinZipPath(baseDir, path));

const parseNumberList = (value: string | null | undefined) =>
  (value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((number) => Number.isFinite(number));

const parseBox = (value: string | null | undefined): OfdBox | null => {
  const values = parseNumberList(value);
  if (values.length < 4) return null;
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
};

const toPt = (mm: number) => mm * MM_TO_PT;

const colorToHex = (color: OfdColor) =>
  `#${[color.r, color.g, color.b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

const parseColorElement = (element: Element | null): OfdColor | undefined => {
  if (!element) return undefined;
  const values = parseNumberList(element.getAttribute('Value'));
  if (values.length < 3) return undefined;
  const alphaValue = element.getAttribute('Alpha');
  const alpha =
    alphaValue == null ? 1 : Math.max(0, Math.min(255, Number(alphaValue))) / 255;
  return { r: values[0], g: values[1], b: values[2], alpha };
};

const extractColor = (element: Element, name: 'FillColor' | 'StrokeColor') =>
  parseColorElement(firstChild(element, name));

const parseDrawParams = (publicResXml: XMLDocument) => {
  const drawParams = new Map<string, DrawParam>();

  for (const element of allElements(publicResXml, 'DrawParam')) {
    const id = element.getAttribute('ID');
    if (!id) continue;

    drawParams.set(id, {
      id,
      relative: element.getAttribute('Relative') ?? undefined,
      lineWidth: Number(element.getAttribute('LineWidth')) || undefined,
      fillColor: extractColor(element, 'FillColor'),
      strokeColor: extractColor(element, 'StrokeColor'),
    });
  }

  const resolving = new Set<string>();
  const resolve = (id: string): DrawParam | undefined => {
    const current = drawParams.get(id);
    if (!current || resolving.has(id)) return current;

    resolving.add(id);
    const parent = current.relative ? resolve(current.relative) : undefined;
    if (parent) {
      current.lineWidth ??= parent.lineWidth;
      current.fillColor ??= parent.fillColor;
      current.strokeColor ??= parent.strokeColor;
    }
    resolving.delete(id);
    return current;
  };

  for (const id of drawParams.keys()) resolve(id);
  return drawParams;
};

const parseFonts = (publicResXml: XMLDocument) => {
  const fonts = new Map<string, FontDef>();
  for (const element of allElements(publicResXml, 'Font')) {
    const id = element.getAttribute('ID');
    if (!id) continue;
    const name = element.getAttribute('FontName') ?? '';
    fonts.set(id, {
      id,
      name,
      family: element.getAttribute('FamilyName') ?? name,
    });
  }
  return fonts;
};

const parseMedia = (documentResXml: XMLDocument, docDir: string) => {
  const media = new Map<string, MediaDef>();
  const baseLoc = documentResXml.documentElement.getAttribute('BaseLoc') ?? '';

  for (const element of allElements(documentResXml, 'MultiMedia')) {
    const id = element.getAttribute('ID');
    const mediaFile = textOf(element, 'MediaFile');
    if (!id || !mediaFile) continue;

    media.set(id, {
      id,
      format: element.getAttribute('Format') ?? '',
      path: resolveRelativePath(docDir, joinZipPath(baseLoc, mediaFile)),
    });
  }

  return media;
};

const parseOfdPackage = async (file: File): Promise<OfdDocument> => {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const ofdEntry = zip.file('OFD.xml');
  if (!ofdEntry) throw new Error('OFD.xml was not found in this OFD file.');

  const ofdXml = parseXml(await ofdEntry.async('string'));
  const docRoot = normalizeZipPath(firstTextIn(ofdXml, 'DocRoot'));
  if (!docRoot) throw new Error('OFD document root was not found.');

  const documentEntry = zip.file(docRoot);
  if (!documentEntry) throw new Error(`OFD document was not found: ${docRoot}`);

  const documentXml = parseXml(await documentEntry.async('string'));
  const docDir = dirname(docRoot);
  const commonData = firstChild(documentXml.documentElement, 'CommonData');
  const pageArea = commonData ? firstChild(commonData, 'PageArea') : null;
  const pageBox =
    parseBox(textOf(pageArea ?? documentXml, 'PhysicalBox')) ?? DEFAULT_PAGE_BOX;

  const publicResPath = resolveRelativePath(
    docDir,
    commonData ? textOf(commonData, 'PublicRes') : ''
  );
  const documentResPath = resolveRelativePath(
    docDir,
    commonData ? textOf(commonData, 'DocumentRes') : ''
  );
  const publicResXml = parseXml(
    await zip.file(publicResPath)?.async('string') ??
      '<?xml version="1.0"?><ofd:Res xmlns:ofd="http://www.ofdspec.org/2016"/>'
  );
  const documentResXml = parseXml(
    await zip.file(documentResPath)?.async('string') ??
      '<?xml version="1.0"?><ofd:Res xmlns:ofd="http://www.ofdspec.org/2016"/>'
  );

  const templates = new Map<string, TemplateDef>();
  for (const element of allElements(documentXml, 'TemplatePage')) {
    const id = element.getAttribute('ID');
    const baseLoc = element.getAttribute('BaseLoc');
    if (!id || !baseLoc) continue;
    templates.set(id, {
      id,
      path: resolveRelativePath(docDir, baseLoc),
      zOrder: element.getAttribute('ZOrder') ?? 'Background',
    });
  }

  const pages: PageDef[] = allElements(documentXml, 'Page')
    .map((element) => ({
      id: element.getAttribute('ID') ?? '',
      path: resolveRelativePath(docDir, element.getAttribute('BaseLoc') ?? ''),
    }))
    .filter((page) => page.id && page.path);

  return {
    zip,
    docDir,
    pageBox,
    drawParams: parseDrawParams(publicResXml),
    fonts: parseFonts(publicResXml),
    media: parseMedia(documentResXml, docDir),
    pages,
    templates,
  };
};

const readXmlFromZip = async (ofd: OfdDocument, path: string) => {
  const entry = ofd.zip.file(path);
  if (!entry) throw new Error(`OFD page content was not found: ${path}`);
  return parseXml(await entry.async('string'));
};

const parseTextCodes = (textObject: Element): TextCode[] =>
  directChildren(textObject, 'TextCode')
    .map((element) => ({
      text: element.textContent ?? '',
      x: Number(element.getAttribute('X')) || 0,
      y: Number(element.getAttribute('Y')) || 0,
      deltaX: parseNumberList(element.getAttribute('DeltaX')),
    }))
    .filter((code) => code.text.length > 0);

const getEffectiveDrawParam = (
  ofd: OfdDocument,
  layer: Element,
  object: Element
) => {
  const objectDrawParam = object.getAttribute('DrawParam');
  const layerDrawParam = layer.getAttribute('DrawParam');
  return (
    (objectDrawParam ? ofd.drawParams.get(objectDrawParam) : undefined) ??
    (layerDrawParam ? ofd.drawParams.get(layerDrawParam) : undefined)
  );
};

const getObjectFillColor = (
  object: Element,
  drawParam: DrawParam | undefined,
  fallback: OfdColor
) => extractColor(object, 'FillColor') ?? drawParam?.fillColor ?? fallback;

const getObjectStrokeColor = (
  object: Element,
  drawParam: DrawParam | undefined,
  fallback: OfdColor
) => extractColor(object, 'StrokeColor') ?? drawParam?.strokeColor ?? fallback;

const tokenizePath = (data: string) =>
  data.match(/[MLCQAZ]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? [];

const parsePathNumber = (tokens: string[], index: number) =>
  Number(tokens[index] ?? 0) || 0;

const drawPathObject = (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  layer: Element,
  object: Element
) => {
  const box = parseBox(object.getAttribute('Boundary'));
  const abbreviatedData = textOf(object, 'AbbreviatedData');
  if (!box || !abbreviatedData) return;

  const drawParam = getEffectiveDrawParam(ofd, layer, object);
  const strokeColor = getObjectStrokeColor(object, drawParam, {
    r: 0,
    g: 0,
    b: 0,
    alpha: 1,
  });
  const fillColor = extractColor(object, 'FillColor');
  const tokens = tokenizePath(abbreviatedData);
  let index = 0;

  doc
    .save()
    .opacity(strokeColor.alpha)
    .strokeColor(colorToHex(strokeColor))
    .lineWidth(toPt(drawParam?.lineWidth ?? 0.25));
  if (fillColor) doc.fillColor(colorToHex(fillColor));

  while (index < tokens.length) {
    const command = tokens[index++].toUpperCase();
    if (command === 'M') {
      const x = parsePathNumber(tokens, index);
      const y = parsePathNumber(tokens, index + 1);
      index += 2;
      doc.moveTo(toPt(box.x + x), toPt(box.y + y));
    } else if (command === 'L') {
      const x = parsePathNumber(tokens, index);
      const y = parsePathNumber(tokens, index + 1);
      index += 2;
      doc.lineTo(toPt(box.x + x), toPt(box.y + y));
    } else if (command === 'C') {
      const cp1x = parsePathNumber(tokens, index);
      const cp1y = parsePathNumber(tokens, index + 1);
      const cp2x = parsePathNumber(tokens, index + 2);
      const cp2y = parsePathNumber(tokens, index + 3);
      const x = parsePathNumber(tokens, index + 4);
      const y = parsePathNumber(tokens, index + 5);
      index += 6;
      doc.bezierCurveTo(
        toPt(box.x + cp1x),
        toPt(box.y + cp1y),
        toPt(box.x + cp2x),
        toPt(box.y + cp2y),
        toPt(box.x + x),
        toPt(box.y + y)
      );
    } else if (command === 'Q') {
      const cpx = parsePathNumber(tokens, index);
      const cpy = parsePathNumber(tokens, index + 1);
      const x = parsePathNumber(tokens, index + 2);
      const y = parsePathNumber(tokens, index + 3);
      index += 4;
      doc.quadraticCurveTo(
        toPt(box.x + cpx),
        toPt(box.y + cpy),
        toPt(box.x + x),
        toPt(box.y + y)
      );
    } else if (command === 'Z') {
      doc.closePath();
    }
  }

  if (fillColor && !strokeColor) {
    doc.fill();
  } else {
    doc.stroke();
  }
  doc.restore();
};

const fontNameForObject = (font: FontDef | undefined) => {
  const family = `${font?.name ?? ''} ${font?.family ?? ''}`;
  if (/courier/i.test(family)) return 'Courier';
  if (/times/i.test(family)) return 'Times-Roman';
  if (/黑体|simhei|hei/i.test(family)) return 'ofd-text-bold';
  if (/楷体|kaiti|kai/i.test(family)) return 'ofd-text';
  return 'ofd-text-light';
};

const fallbackAdvance = (char: string, size: number) =>
  /[^\x00-\x7F]/.test(char) ? size : size * 0.5;

const drawTextCode = (
  doc: PdfKitDocument,
  code: TextCode,
  box: OfdBox,
  size: number,
  fontName: string
) => {
  const chars = Array.from(code.text);
  let currentX = code.x;
  const y = toPt(box.y + code.y - size * 0.82);

  doc.font(fontName).fontSize(toPt(size));
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    doc.text(char, toPt(box.x + currentX), y, { lineBreak: false });
    currentX += code.deltaX[i] ?? fallbackAdvance(char, size);
  }
};

const drawTextObject = (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  layer: Element,
  object: Element
) => {
  const box = parseBox(object.getAttribute('Boundary'));
  if (!box) return;

  const fontId = object.getAttribute('Font') ?? '';
  const size = Number(object.getAttribute('Size')) || 3;
  const drawParam = getEffectiveDrawParam(ofd, layer, object);
  const fillColor = getObjectFillColor(object, drawParam, {
    r: 0,
    g: 0,
    b: 0,
    alpha: 1,
  });
  const fontName = fontNameForObject(ofd.fonts.get(fontId));

  doc.save().opacity(fillColor.alpha).fillColor(colorToHex(fillColor));
  for (const code of parseTextCodes(object)) {
    drawTextCode(doc, code, box, size, fontName);
  }
  doc.restore();
};

const bytesToDataUrl = (bytes: Uint8Array, mimeType: string) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
};

const mimeTypeForMedia = (media: MediaDef) => {
  const source = `${media.format} ${media.path}`.toLowerCase();
  if (source.includes('png')) return 'image/png';
  if (source.includes('jpg') || source.includes('jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
};

const drawImageObject = async (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  object: Element
) => {
  const box = parseBox(object.getAttribute('Boundary'));
  const resourceId = object.getAttribute('ResourceID') ?? '';
  const media = ofd.media.get(resourceId);
  if (!box || !media) return;

  const entry = ofd.zip.file(media.path);
  if (!entry) return;

  const bytes = await entry.async('uint8array');
  doc.image(bytesToDataUrl(bytes, mimeTypeForMedia(media)), toPt(box.x), toPt(box.y), {
    width: toPt(box.width),
    height: toPt(box.height),
  });
};

const drawLayer = async (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  layer: Element
) => {
  for (const object of directChildren(layer)) {
    if (localName(object) === 'PathObject') {
      drawPathObject(doc, ofd, layer, object);
    } else if (localName(object) === 'TextObject') {
      drawTextObject(doc, ofd, layer, object);
    } else if (localName(object) === 'ImageObject') {
      await drawImageObject(doc, ofd, object);
    }
  }
};

const drawPageXml = async (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  pageXml: XMLDocument
) => {
  for (const content of directChildren(pageXml.documentElement, 'Content')) {
    for (const layer of directChildren(content, 'Layer')) {
      await drawLayer(doc, ofd, layer);
    }
  }
};

const getPageBox = (ofd: OfdDocument, pageXml: XMLDocument) => {
  const area = firstChild(pageXml.documentElement, 'Area');
  return parseBox(textOf(area ?? pageXml, 'PhysicalBox')) ?? ofd.pageBox;
};

const getPageTemplateIds = (pageXml: XMLDocument) =>
  directChildren(pageXml.documentElement, 'Template')
    .sort((a, b) =>
      (a.getAttribute('ZOrder') ?? '').localeCompare(b.getAttribute('ZOrder') ?? '')
    )
    .map((element) => element.getAttribute('TemplateID') ?? '')
    .filter(Boolean);

const renderOfdPageToPdf = async (
  doc: PdfKitDocument,
  ofd: OfdDocument,
  page: PageDef
) => {
  const pageXml = await readXmlFromZip(ofd, page.path);
  const pageBox = getPageBox(ofd, pageXml);
  doc.addPage({
    size: [toPt(pageBox.width), toPt(pageBox.height)],
    margin: 0,
  });

  for (const templateId of getPageTemplateIds(pageXml)) {
    const template = ofd.templates.get(templateId);
    if (!template) continue;
    await drawPageXml(doc, ofd, await readXmlFromZip(ofd, template.path));
  }

  await drawPageXml(doc, ofd, pageXml);
};

const fetchFontBytes = async (url: string) => {
  const fontResponse = await fetch(url);
  if (!fontResponse.ok) {
    throw new Error('Unable to load OFD PDF text font.');
  }

  return new Uint8Array(await fontResponse.arrayBuffer());
};

const loadPdfTextFonts = async (): Promise<OfdPdfFonts> => {
  const [regular, light, bold] = await Promise.all([
    fetchFontBytes(ofdTextFontRegularUrl),
    fetchFontBytes(ofdTextFontLightUrl),
    fetchFontBytes(ofdTextFontBoldUrl),
  ]);

  return { bold, light, regular };
};

const loadPdfKit = async () => {
  installPdfBrowserShims();
  const [pdfKitModule, blobStreamModule] = await Promise.all([
    import('pdfkit/js/pdfkit.standalone.js'),
    import('blob-stream'),
  ]);

  return {
    PDFDocument: pdfKitModule.default as PdfKitConstructor,
    blobStream: blobStreamModule.default as () => BlobStream,
  };
};

const finishPdfKitDocument = (doc: PdfKitDocument, stream: BlobStream) =>
  new Promise<Blob>((resolve, reject) => {
    stream.on('finish', () => resolve(stream.toBlob('application/pdf')));
    stream.on('error', (error?: Error) =>
      reject(error ?? new Error('Unable to generate PDF.'))
    );
    doc.end();
  });

const createPdfKitDocument = (
  PDFDocument: PdfKitConstructor,
  blobStream: () => BlobStream,
  fonts: OfdPdfFonts
) => {
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    margin: 0,
  });
  const stream = doc.pipe(blobStream()) as BlobStream;
  doc.registerFont('ofd-text', fonts.regular);
  doc.registerFont('ofd-text-light', fonts.light);
  doc.registerFont('ofd-text-bold', fonts.bold);
  return { doc, stream };
};

const convertSingleOfdFile = async (
  file: File,
  PDFDocument: PdfKitConstructor,
  blobStream: () => BlobStream,
  fonts: OfdPdfFonts
) => {
  const ofd = await parseOfdPackage(file);
  if (ofd.pages.length === 0) {
    throw new Error('No pages found in OFD document.');
  }

  const { doc, stream } = createPdfKitDocument(PDFDocument, blobStream, fonts);
  for (let i = 0; i < ofd.pages.length; i++) {
    showLoader(`Rendering page ${i + 1} of ${ofd.pages.length}...`);
    await renderOfdPageToPdf(doc, ofd, ofd.pages[i]);
  }
  return finishPdfKitDocument(doc, stream);
};

const blobToArrayBuffer = (blob: Blob) => blob.arrayBuffer();

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const processBtn = document.getElementById('process-btn');
  const fileDisplayArea = document.getElementById('file-display-area');
  const fileControls = document.getElementById('file-controls');
  const addMoreBtn = document.getElementById('add-more-btn');
  const clearFilesBtn = document.getElementById('clear-files-btn');
  const backBtn = document.getElementById('back-to-tools');

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = import.meta.env.BASE_URL;
    });
  }

  const convertOptions = document.getElementById('convert-options');

  const updateUI = () => {
    if (!fileDisplayArea || !processBtn || !fileControls) return;

    if (state.files.length > 0) {
      fileDisplayArea.innerHTML = '';

      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        const fileDiv = document.createElement('div');
        fileDiv.className =
          'flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm';

        const infoContainer = document.createElement('div');
        infoContainer.className = 'flex flex-col overflow-hidden';

        const nameSpan = document.createElement('div');
        nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
        nameSpan.textContent = file.name;

        const metaSpan = document.createElement('div');
        metaSpan.className = 'text-xs text-gray-400';
        metaSpan.textContent = formatBytes(file.size);

        infoContainer.append(nameSpan, metaSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className =
          'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
        removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
        removeBtn.onclick = () => {
          state.files = state.files.filter((_, i) => i !== index);
          updateUI();
        };

        fileDiv.append(infoContainer, removeBtn);
        fileDisplayArea.appendChild(fileDiv);
      }

      createIcons({ icons });
      fileControls.classList.remove('hidden');
      if (convertOptions) convertOptions.classList.remove('hidden');
      (processBtn as HTMLButtonElement).disabled = false;
    } else {
      fileDisplayArea.innerHTML = '';
      fileControls.classList.add('hidden');
      if (convertOptions) convertOptions.classList.add('hidden');
      (processBtn as HTMLButtonElement).disabled = true;
    }
  };

  const resetState = () => {
    state.files = [];
    state.pdfDoc = null;
    updateUI();
  };

  const convertToPdf = async () => {
    try {
      if (state.files.length === 0) {
        showAlert('No Files', 'Please select at least one OFD file.');
        return;
      }

      showLoader('Loading OFD converter...');
      const { PDFDocument, blobStream } = await loadPdfKit();
      const fonts = await loadPdfTextFonts();

      if (state.files.length === 1) {
        const file = state.files[0];
        showLoader(`Converting ${file.name}...`);
        const pdfBlob = await convertSingleOfdFile(
          file,
          PDFDocument,
          blobStream,
          fonts
        );
        const fileName = file.name.replace(/\.[^.]+$/, '') + '.pdf';
        downloadFile(pdfBlob, fileName);

        hideLoader();
        showAlert(
          'Conversion Complete',
          `Successfully converted ${file.name} to PDF.`,
          'success',
          () => resetState()
        );
      } else {
        showLoader('Converting files...');
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        for (let f = 0; f < state.files.length; f++) {
          const file = state.files[f];
          showLoader(`Converting ${f + 1}/${state.files.length}: ${file.name}...`);
          const baseName = file.name.replace(/\.[^.]+$/, '');
          const pdfBlob = await convertSingleOfdFile(
            file,
            PDFDocument,
            blobStream,
            fonts
          );
          zip.file(`${baseName}.pdf`, await blobToArrayBuffer(pdfBlob));
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        downloadFile(zipBlob, 'ofd-converted.zip');

        hideLoader();
        showAlert(
          'Conversion Complete',
          `Successfully converted ${state.files.length} OFD file(s) to PDF.`,
          'success',
          () => resetState()
        );
      }
    } catch (e: unknown) {
      console.error('[OFD2PDF] ERROR:', e);
      hideLoader();
      showAlert(
        'Error',
        `An error occurred during conversion. Error: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      state.files = [...state.files, ...Array.from(files)];
      updateUI();
    }
  };

  if (fileInput && dropZone) {
    fileInput.addEventListener('change', (e) => {
      handleFileSelect((e.target as HTMLInputElement).files);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-gray-700');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const validFiles = Array.from(files).filter((f) => {
          const name = f.name.toLowerCase();
          return EXTENSIONS.some((ext) => name.endsWith(ext));
        });
        if (validFiles.length > 0) {
          const dataTransfer = new DataTransfer();
          validFiles.forEach((f) => dataTransfer.items.add(f));
          handleFileSelect(dataTransfer.files);
        }
      }
    });

    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
  }

  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      resetState();
    });
  }

  if (processBtn) {
    processBtn.addEventListener('click', convertToPdf);
  }
});
