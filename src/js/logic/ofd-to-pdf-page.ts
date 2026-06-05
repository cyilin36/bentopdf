import { showLoader, hideLoader, showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { state } from '../state.js';
import { createIcons, icons } from 'lucide';
import fontkit from '@pdf-lib/fontkit';
import ofdTextFontUrl from '../../../node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf?url';
import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';

const FILETYPE = 'ofd';
const EXTENSIONS = ['.ofd'];
const TOOL_NAME = 'OFD';
const RENDER_WIDTH = 796;
const POINTS_PER_INCH = 72;
const MILLIMETERS_PER_INCH = 25.4;

type PdfPageSize = {
  width: number;
  height: number;
};

type SelectableTextRun = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: RGB;
  targetWidth: number;
};

type OfdToolsModule = {
  parseOfdDocument: (options: {
    ofd: File | ArrayBuffer | string;
    success?: (res: any[]) => void;
    fail?: (e: unknown) => void;
  }) => void;
  renderOfd: (screenWidth: number, ofd: any) => HTMLDivElement[];
};

type BrowserRequireGlobal = {
  global?: typeof globalThis;
  require?: (name: string) => unknown;
};

const installAsn1RequireShim = async () => {
  const globalScope = globalThis as unknown as BrowserRequireGlobal;
  globalScope.global = globalThis;
  if (globalScope.require) return;

  const [int10Module, oidsModule] = await Promise.all([
    import('@lapo/asn1js/int10'),
    import('@lapo/asn1js/oids'),
  ]);
  const modules: Record<string, unknown> = {
    './int10': int10Module.default ?? int10Module,
    './oids': oidsModule.default ?? oidsModule,
  };

  globalScope.require = (name: string) => {
    if (Object.prototype.hasOwnProperty.call(modules, name)) {
      return modules[name];
    }
    throw new Error(`Unsupported browser require: ${name}`);
  };
};

const loadOfdTools = async (): Promise<OfdToolsModule> => {
  await installAsn1RequireShim();
  return (await import('ofd-tools')) as OfdToolsModule;
};

const removeSignatureReferences = (xml: string) => {
  const xmlDocument = new DOMParser().parseFromString(xml, 'application/xml');
  if (xmlDocument.querySelector('parsererror')) return xml;

  const signatureReferences = Array.from(
    xmlDocument.getElementsByTagNameNS('*', 'Signatures')
  );
  if (signatureReferences.length === 0) return xml;

  for (const reference of signatureReferences) {
    reference.parentNode?.removeChild(reference);
  }

  return new XMLSerializer().serializeToString(xmlDocument);
};

const getLocalNameElements = (element: Element | XMLDocument, name: string) =>
  Array.from(element.getElementsByTagNameNS('*', name));

const resolveZipPath = (parts: string[]) =>
  parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+/, '');

const resolveMediaPath = (
  entryName: string,
  mediaFile: string,
  baseLoc: string | null
) => {
  const docRoot = entryName.split('/')[0] ?? '';
  let filePath = mediaFile.replace(/^\/+/, '');
  const normalizedBaseLoc = baseLoc?.replace(/^\/+|\/+$/g, '') ?? '';

  if (normalizedBaseLoc && !filePath.includes(normalizedBaseLoc)) {
    filePath = resolveZipPath([normalizedBaseLoc, filePath]);
  }

  if (docRoot && !filePath.includes(docRoot)) {
    filePath = resolveZipPath([docRoot, filePath]);
  }

  return filePath;
};

const removeMissingMediaReferences = (
  xml: string,
  entryName: string,
  zip: any
) => {
  const xmlDocument = new DOMParser().parseFromString(xml, 'application/xml');
  if (xmlDocument.querySelector('parsererror')) return xml;

  const mediaElements = getLocalNameElements(xmlDocument, 'MultiMedia');
  if (mediaElements.length === 0) return xml;

  let changed = false;
  for (const mediaElement of mediaElements) {
    const mediaFileElement = getLocalNameElements(mediaElement, 'MediaFile')[0];
    const mediaFile = mediaFileElement?.textContent?.trim();
    const expectedPath = mediaFile
      ? resolveMediaPath(
          entryName,
          mediaFile,
          mediaElement.parentElement?.parentElement?.getAttribute('BaseLoc') ??
            xmlDocument.documentElement.getAttribute('BaseLoc')
        )
      : '';

    if (!expectedPath || !zip.file(expectedPath)) {
      mediaElement.parentNode?.removeChild(mediaElement);
      changed = true;
    }
  }

  return changed ? new XMLSerializer().serializeToString(xmlDocument) : xml;
};

const createRenderableOfdBuffer = async (file: File) => {
  const originalBuffer = await file.arrayBuffer();
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(originalBuffer.slice(0));
  let changed = false;

  const ofdEntry = zip.file('OFD.xml');
  if (ofdEntry) {
    const ofdXml = await ofdEntry.async('string');
    const renderableOfdXml = removeSignatureReferences(ofdXml);
    if (renderableOfdXml !== ofdXml) {
      zip.file('OFD.xml', renderableOfdXml);
      changed = true;
    }
  }

  const xmlEntries = Object.values(zip.files).filter(
    (entry: any) => !entry.dir && entry.name.toLowerCase().endsWith('.xml')
  ) as Array<{ name: string; async: (type: 'string') => Promise<string> }>;
  for (const entry of xmlEntries) {
    const xml = await entry.async('string');
    const renderableXml = removeMissingMediaReferences(xml, entry.name, zip);
    if (renderableXml !== xml) {
      zip.file(entry.name, renderableXml);
      changed = true;
    }
  }

  return changed ? zip.generateAsync({ type: 'arraybuffer' }) : originalBuffer;
};

const parseOfdFile = async (
  file: File,
  parseOfdDocument: OfdToolsModule['parseOfdDocument']
) => {
  const ofdBuffer = await createRenderableOfdBuffer(file);

  return new Promise<any>((resolve, reject) => {
    parseOfdDocument({
      ofd: ofdBuffer,
      success(res: any[]) {
        resolve(res[0]);
      },
      fail(e: unknown) {
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    });
  });
};

const normalizeDrawParamInheritance = (ofdObj: any) => {
  const drawParams = ofdObj?.drawParamResObj;
  if (!drawParams || typeof drawParams !== 'object') return;

  const resolving = new Set<string>();
  const resolveParam = (id: string): any => {
    const param = drawParams[id];
    if (!param || typeof param !== 'object' || resolving.has(id)) return param;

    resolving.add(id);
    const parentId = param.relative ?? param.Relative;
    const parent = parentId ? resolveParam(String(parentId)) : null;
    if (parent && typeof parent === 'object') {
      for (const key of ['LineWidth', 'FillColor', 'StrokeColor']) {
        if (!param[key] && parent[key]) {
          param[key] = parent[key];
        }
      }
    }
    resolving.delete(id);

    // ofd-tools switches to the parent DrawParam during rendering and then
    // misses the child FillColor. Materialize inheritance before rendering.
    delete param.relative;
    delete param.Relative;
    return param;
  };

  for (const id of Object.keys(drawParams)) {
    resolveParam(id);
  }
};

const waitForRenderAssets = async (page: HTMLElement) => {
  const images = Array.from(page.querySelectorAll('img'));
  await Promise.all(
    images.map((img) => {
      if (img.complete) return Promise.resolve();

      return new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    })
  );

  await new Promise((resolve) => requestAnimationFrame(resolve));
};

const getElementSize = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width || element.offsetWidth || RENDER_WIDTH);
  const height = Math.ceil(rect.height || element.offsetHeight || 1123);
  return { width, height };
};

const parseBoxString = (box?: string) => {
  const values = box?.trim().split(/\s+/).map(Number);
  if (
    !values ||
    values.length < 4 ||
    values.some((value) => Number.isNaN(value))
  ) {
    return null;
  }

  return {
    x: values[0],
    y: values[1],
    width: values[2],
    height: values[3],
  };
};

const getOfdPageBox = (ofdObj: any, page: any) => {
  const pageId = Object.keys(page)[0];
  const pageArea = page[pageId]?.json?.['ofd:Area'];
  const documentArea = ofdObj?.document?.['ofd:CommonData']?.['ofd:PageArea'];

  return (
    parseBoxString(pageArea?.['ofd:PhysicalBox']) ??
    parseBoxString(pageArea?.['ofd:ApplicationBox']) ??
    parseBoxString(pageArea?.['ofd:ContentBox']) ??
    parseBoxString(documentArea?.['ofd:PhysicalBox']) ??
    parseBoxString(documentArea?.['ofd:ApplicationBox']) ??
    parseBoxString(documentArea?.['ofd:ContentBox'])
  );
};

const getPdfPageSize = (
  ofdObj: any,
  page: any,
  fallbackElement: HTMLElement
) => {
  const ofdBox = getOfdPageBox(ofdObj, page);
  if (ofdBox) {
    return {
      width: (ofdBox.width * POINTS_PER_INCH) / MILLIMETERS_PER_INCH,
      height: (ofdBox.height * POINTS_PER_INCH) / MILLIMETERS_PER_INCH,
    };
  }

  return getElementSize(fallbackElement);
};

const getPdfOrientation = (size: { width: number; height: number }) =>
  size.width > size.height ? 'landscape' : 'portrait';

const rasterizeSvgToPng = (svg: SVGSVGElement, width: number, height: number) =>
  new Promise<string>((resolve, reject) => {
    const serializedSvg = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    const scale = 2;

    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(width * scale));
      canvas.height = Math.max(1, Math.ceil(height * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Unable to create SVG rasterization context.'));
        return;
      }

      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Unable to rasterize SVG layer.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      serializedSvg
    )}`;
  });

const normalizeSvgPaint = (svg: SVGSVGElement) => {
  const paintedElements = Array.from(
    svg.querySelectorAll<SVGElement>('[fill], [stroke]')
  );

  for (const element of paintedElements) {
    const fill = element.getAttribute('fill');
    if (!fill || fill === 'null' || fill === 'undefined') {
      if (element.tagName.toLowerCase() === 'text') {
        element.setAttribute('fill', 'rgb(0, 0, 0)');
      } else if (fill) {
        element.setAttribute('fill', 'none');
      }
    }

    const stroke = element.getAttribute('stroke');
    if (!stroke || stroke === 'null' || stroke === 'undefined') {
      if (stroke) element.setAttribute('stroke', 'none');
    }
  }
};

const rasterizeInlineSvgs = async (page: HTMLElement) => {
  const svgs = Array.from(page.querySelectorAll('svg'));

  for (const svg of svgs) {
    const rect = svg.getBoundingClientRect();
    const width = Math.ceil(rect.width || parseFloat(svg.style.width) || 1);
    const height = Math.ceil(rect.height || parseFloat(svg.style.height) || 1);
    const clone = svg.cloneNode(true) as SVGSVGElement;

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    clone.setAttribute(
      'style',
      `overflow:visible;width:${width}px;height:${height}px;`
    );
    normalizeSvgPaint(clone);

    const image = document.createElement('img');
    image.src = await rasterizeSvgToPng(clone, width, height);
    image.setAttribute('style', svg.getAttribute('style') ?? '');
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.objectFit = 'fill';

    svg.replaceWith(image);
  }
};

const parseCssColorToRgb = (value: string | null): RGB => {
  if (!value || value === 'null' || value === 'undefined') return rgb(0, 0, 0);

  const rgbMatch = value.match(
    /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/
  );
  if (rgbMatch) {
    return rgb(
      Number(rgbMatch[1]) / 255,
      Number(rgbMatch[2]) / 255,
      Number(rgbMatch[3]) / 255
    );
  }

  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex =
      hexMatch[1].length === 3
        ? hexMatch[1]
            .split('')
            .map((char) => char + char)
            .join('')
        : hexMatch[1];
    return rgb(
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255
    );
  }

  return rgb(0, 0, 0);
};

const extractSelectableTextRuns = (
  page: HTMLElement,
  pdfPageSize: PdfPageSize
): SelectableTextRun[] => {
  const pageRect = page.getBoundingClientRect();
  const pageWidth = pageRect.width || getElementSize(page).width;
  const pageHeight = pageRect.height || getElementSize(page).height;
  const scaleX = pdfPageSize.width / pageWidth;
  const scaleY = pdfPageSize.height / pageHeight;
  const textElements = Array.from(
    page.querySelectorAll<SVGTextElement>('text')
  );

  return textElements
    .map((textElement) => {
      const text = textElement.textContent ?? '';
      const parentSvg = textElement.closest('svg');
      if (!text.trim() || !parentSvg) return null;

      const svgRect = parentSvg.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(textElement);
      const fontSizePx =
        parseFloat(computedStyle.fontSize) ||
        parseFloat(textElement.style.fontSize) ||
        10;
      const localX = parseFloat(textElement.getAttribute('x') ?? '0') || 0;
      const localY = parseFloat(textElement.getAttribute('y') ?? '0') || 0;
      const xPx = svgRect.left - pageRect.left + localX;
      const baselineYPx = svgRect.top - pageRect.top + localY;
      const fill =
        textElement.getAttribute('fill') ||
        computedStyle.fill ||
        computedStyle.color;
      const targetWidthPx =
        typeof textElement.getComputedTextLength === 'function'
          ? textElement.getComputedTextLength()
          : textElement.getBoundingClientRect().width;

      return {
        text,
        x: xPx * scaleX,
        y: pdfPageSize.height - baselineYPx * scaleY,
        fontSize: fontSizePx * scaleY,
        color: parseCssColorToRgb(fill),
        targetWidth: targetWidthPx * scaleX,
      };
    })
    .filter((run): run is SelectableTextRun => Boolean(run));
};

const loadPdfTextFont = async (pdfDoc: PDFDocument) => {
  pdfDoc.registerFontkit(fontkit);
  const fontResponse = await fetch(ofdTextFontUrl);
  if (!fontResponse.ok) {
    throw new Error('Unable to load OFD PDF text font.');
  }

  return pdfDoc.embedFont(await fontResponse.arrayBuffer(), { subset: true });
};

const fitTextFontSize = (font: PDFFont, run: SelectableTextRun) => {
  if (run.targetWidth <= 0) return run.fontSize;

  const renderedWidth = font.widthOfTextAtSize(run.text, run.fontSize);
  if (renderedWidth <= run.targetWidth || renderedWidth === 0) {
    return run.fontSize;
  }

  return Math.max(1, run.fontSize * (run.targetWidth / renderedWidth));
};

const drawSelectableTextRuns = (
  pdfPage: PDFPage,
  font: PDFFont,
  textRuns: SelectableTextRun[]
) => {
  for (const run of textRuns) {
    pdfPage.drawText(run.text, {
      x: run.x,
      y: run.y,
      size: fitTextFontSize(font, run),
      font,
      color: run.color,
      opacity: 0,
    });
  }
};

const uint8ArrayToArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

const addRenderedPageToPdf = async (
  pdfDoc: PDFDocument,
  textFont: PDFFont,
  page: HTMLElement,
  pdfPageSize: PdfPageSize,
  html2canvas: typeof import('html2canvas').default
) => {
  const textRuns = extractSelectableTextRuns(page, pdfPageSize);
  await rasterizeInlineSvgs(page);
  await waitForRenderAssets(page);

  const canvas = await html2canvas(page, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#ffffff',
  });
  const pdfPage = pdfDoc.addPage([pdfPageSize.width, pdfPageSize.height]);
  const pageImage = await pdfDoc.embedPng(canvas.toDataURL('image/png'));
  pdfPage.drawImage(pageImage, {
    x: 0,
    y: 0,
    width: pdfPageSize.width,
    height: pdfPageSize.height,
  });
  drawSelectableTextRuns(pdfPage, textFont, textRuns);
};

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

      showLoader('Loading OFD engine...');
      const ofdTools = await loadOfdTools();
      const { parseOfdDocument, renderOfd } = ofdTools;

      // Hidden container for offscreen DOM rendering
      const container = document.createElement('div');
      container.id = 'ofd-render-container';
      container.style.cssText = `position:absolute;left:-10000px;top:0;width:${RENDER_WIDTH}px;background:#fff;pointer-events:none;`;
      document.body.appendChild(container);

      try {
        const html2canvas = (await import('html2canvas')).default;

        if (state.files.length === 1) {
          const file = state.files[0];
          showLoader(`Converting ${file.name}...`);

          const ofdObj = await parseOfdFile(file, parseOfdDocument);
          normalizeDrawParamInheritance(ofdObj);

          const pages = renderOfd(RENDER_WIDTH, ofdObj);
          if (!pages || pages.length === 0) {
            throw new Error('No pages found in OFD document.');
          }

          container.innerHTML = '';
          container.appendChild(pages[0]);
          await waitForRenderAssets(pages[0]);
          const pdfDoc = await PDFDocument.create();
          const textFont = await loadPdfTextFont(pdfDoc);

          for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const pdfPageSize = getPdfPageSize(ofdObj, page, page);
            if (i > 0) {
              container.innerHTML = '';
              container.appendChild(page);
              await waitForRenderAssets(page);
            }

            showLoader(`Rendering page ${i + 1} of ${pages.length}...`);
            await addRenderedPageToPdf(
              pdfDoc,
              textFont,
              page,
              pdfPageSize,
              html2canvas
            );
          }

          showLoader('Generating PDF...');
          const pdfBytes = await pdfDoc.save();
          const pdfBlob = new Blob([uint8ArrayToArrayBuffer(pdfBytes)], {
            type: 'application/pdf',
          });
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
            showLoader(
              `Converting ${f + 1}/${state.files.length}: ${file.name}...`
            );

            const ofdObj = await parseOfdFile(file, parseOfdDocument);
            normalizeDrawParamInheritance(ofdObj);

            const pages = renderOfd(RENDER_WIDTH, ofdObj);
            if (!pages || pages.length === 0) continue;

            container.innerHTML = '';
            container.appendChild(pages[0]);
            await waitForRenderAssets(pages[0]);
            const pdfDoc = await PDFDocument.create();
            const textFont = await loadPdfTextFont(pdfDoc);

            for (let i = 0; i < pages.length; i++) {
              const page = pages[i];
              const pdfPageSize = getPdfPageSize(ofdObj, page, page);
              if (i > 0) {
                container.innerHTML = '';
                container.appendChild(page);
                await waitForRenderAssets(page);
              }

              await addRenderedPageToPdf(
                pdfDoc,
                textFont,
                page,
                pdfPageSize,
                html2canvas
              );
            }

            const baseName = file.name.replace(/\.[^.]+$/, '');
            const pdfOutput = await pdfDoc.save();
            zip.file(`${baseName}.pdf`, pdfOutput);
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
      } finally {
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
      }
    } catch (e: unknown) {
      console.error('[OFD2PDF] ERROR:', e);
      hideLoader();
      // Clean up container on error
      const leftover = document.getElementById('ofd-render-container');
      if (leftover) leftover.remove();
      showAlert(
        'Error',
        `An error occurred during conversion. Error: ${e instanceof Error ? e.message : String(e)}`
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
