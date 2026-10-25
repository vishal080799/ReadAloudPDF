// Pages without usable text — damaged Hindi text layers (spec 003) and scanned pages (spec 004) —
// are read from the page image with Tesseract.
import { downloadFiles, missingFiles, removeFiles } from './voicepacks.js';

const DIR = 'vendor/tesseract/';
// Sizes are only for the progress bar.
const OCR_FILES = {
    [`${DIR}tesseract.min.js`]: 66695,
    [`${DIR}worker.min.js`]: 123724,
    [`${DIR}tesseract-core-simd-lstm.wasm.js`]: 3938657,
    [`${DIR}lang/hin.traineddata.gz`]: 1389692,
    [`${DIR}lang/eng.traineddata.gz`]: 2952873,
};
export const OCR_MEGABYTES = Math.round(Object.values(OCR_FILES).reduce((sum, size) => sum + size, 0) / 1e6);
// Render pages about this wide for recognition; Tesseract reads small Devanagari poorly.
const OCR_WIDTH = 2000;
const MIN_WORD_CONFIDENCE = 30;

let workerPromise = null;
let workerLangs = null;
let queue = Promise.resolve();

// A scanned page is a picture: its text layer is empty or nearly so.
export function isScannedPage(text) {
    return text.replace(/\s/g, '').length < 20;
}

// Which languages to recognise next, judged from a page recognised with both (004-04).
export function languagesFromText(text) {
    const letters = text.match(/[\p{L}\p{M}]/gu) || [];
    if (letters.length < 100) return null;
    const devanagari = letters.filter((c) => c >= 'ऀ' && c <= 'ॿ').length / letters.length;
    if (devanagari > 0.95) return 'hin';
    if (devanagari < 0.05) return 'eng';
    return 'eng+hin';
}

// Some fonts map ि and conjuncts (्) to nothing, so the text layer silently drops them.
// Normal Hindi has ि at about 3% and ् at about 2% of Devanagari characters.
export function isDamagedHindi(text) {
    const devanagari = text.match(/[ऀ-ॿ]/g) || [];
    if (devanagari.length < 80) return false;
    const share = (mark) => devanagari.filter((c) => c === mark).length / devanagari.length;
    return share('ि') < 0.004 && share('्') < 0.005;
}

export function supported() {
    return 'caches' in self && typeof WebAssembly === 'object' && typeof Worker === 'function';
}

export async function isDownloaded() {
    if (!supported()) return false;
    try {
        return (await missingFiles(OCR_FILES)).length === 0;
    } catch (error) {
        return false;
    }
}

export function download(onProgress, signal) {
    return downloadFiles(OCR_FILES, onProgress, signal);
}

async function stopWorker() {
    if (workerPromise) (await workerPromise.catch(() => null))?.terminate();
    workerPromise = null;
    workerLangs = null;
}

export async function remove() {
    await stopWorker();
    await removeFiles(OCR_FILES);
}

function loadScript(src) {
    if (self.Tesseract) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Hindi page reading is not downloaded'));
        document.head.append(script);
    });
}

// One worker at a time; switching languages replaces it (models are large on phones).
async function getWorker(langs) {
    if (workerLangs !== langs) await stopWorker();
    if (!workerPromise) {
        const url = (path) => new URL(path, location.href).href;
        workerLangs = langs;
        workerPromise = loadScript(`${DIR}tesseract.min.js`).then(() => self.Tesseract.createWorker(langs, 1, {
            workerPath: url(`${DIR}worker.min.js`),
            corePath: url(DIR),
            langPath: url(`${DIR}lang`),
            // A real (not blob) worker is controlled by the service worker, so it loads offline.
            workerBlobURL: false,
            cacheMethod: 'none',
            gzip: true,
        }));
        workerPromise.catch(() => { workerPromise = null; workerLangs = null; });
    }
    return workerPromise;
}

// Recognise one pdf.js page. Returns { text, runs } in the same shape as the text layer:
// runs carry character offsets into text and boxes in page units (viewport scale 1).
async function recognize(pdfPage, langs) {
    const worker = await getWorker(langs);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(3, OCR_WIDTH / base.width);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false, willReadFrequently: true }), viewport }).promise;
    const { data } = await worker.recognize(canvas);
    canvas.width = 0;
    canvas.height = 0;

    let text = '';
    const runs = [];
    for (const line of data.lines || []) {
        // Very unsure words are usually decoration (rules, stars, stains) misread as letters.
        const words = (line.words || []).filter((word) => word.text && word.text.trim() && word.confidence >= MIN_WORD_CONFIDENCE);
        words.forEach((word, index) => {
            const { x0, y0, x1, y1 } = word.bbox;
            runs.push({
                start: text.length,
                length: word.text.length,
                x: x0 / scale,
                width: (x1 - x0) / scale,
                top: y0 / scale,
                bottom: y1 / scale,
                height: (y1 - y0) / scale,
            });
            text += word.text + (index < words.length - 1 ? ' ' : '');
        });
        if (words.length) text += '\n';
    }
    return { text, runs };
}

// Pages are recognised one at a time; Tesseract runs a single worker.
// langs: 'hin', 'eng' or 'eng+hin'. langs may be a function, read when the job starts,
// so a queued page uses the language chosen from the pages recognised before it.
export function recognizePage(pdfPage, langs = 'hin') {
    const job = queue.then(() => recognize(pdfPage, typeof langs === 'function' ? langs() : langs));
    queue = job.catch(() => {});
    return job;
}
