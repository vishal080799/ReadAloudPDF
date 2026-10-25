import * as pdfjsLib from './vendor/pdf.min.mjs';
import { speakable } from './pronounce.js';
import * as packs from './voicepacks.js';
import * as ocr from './ocr.js';
import { initSettings } from './settings.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const MAX_UTTERANCE_CHARS = 220;
const MAX_RENDERED_PAGES = 8;
const MAX_CANVAS_WIDTH = 1600;
// A tap farther than this from any text (as a fraction of the page width) is ignored.
const MAX_TAP_DISTANCE = 0.06;

const synth = window.speechSynthesis;
const bar = document.getElementById('bar');
const fileInput = document.getElementById('file');
const startButton = document.getElementById('start');
const previousButton = document.getElementById('previous');
const nextButton = document.getElementById('next');
const stopButton = document.getElementById('stop');
const speed = document.getElementById('speed');
const status = document.getElementById('status');
const voiceNote = document.getElementById('voice-note');
const damageNote = document.getElementById('damage-note');
const empty = document.getElementById('empty');
const pagesElement = document.getElementById('pages');

let pdfDocument = null;
let loadGeneration = 0;
// chunks is the flat reading order, rebuilt from pageChunks (text layer) and ocrChunks (page images).
let chunks = [];
let pageChunks = [];
let pageSizes = [];
let pageCount = 0;
let damagedPages = new Set();
let scannedPages = new Set();
// Scanned pages start with both languages, then narrow to what the document turns out to be (004-04).
let scanLangs = 'eng+hin';
const ocrChunks = new Map(); // page -> chunks recognised from the page image
const recognizing = new Map(); // page -> Promise
let ocrReady = false;
let pendingTap = null;
let positionKey = null;
let voices = [];
let running = false;
let paused = false;
let currentIndex = 0;
let speakToken = 0;
let currentUtterance = null;
let wakeLock = null;
let pageObserver = null;
let markedSheet = null;
const renderedPages = new Map();
const renderingPages = new Set();
// Voice pack audio: one player, and clips made ahead of time by sentence index.
const packPlayer = new Audio();
const clips = new Map(); // index -> { promise, cancel }
let packObjectUrl = null;

for (let rate = 0.7; rate < 2.05; rate += 0.1) {
    speed.add(new Option(`${rate.toFixed(1)}x`, rate.toFixed(1), false, Math.abs(rate - 1) < 0.01));
}


function isDevanagari(text) {
    const devanagariCount = (text.match(/[ऀ-ॿ]/g) || []).length;
    const totalLetters = (text.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
    if (totalLetters === 0) return false;
    return devanagariCount / totalLetters > 0.4;
}

function trimRange(text, start, end) {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return [start, end];
}

// Android speech engines cut off or reject very long utterances.
function splitLong(text, start, end) {
    const ranges = [];
    while (end - start > MAX_UTTERANCE_CHARS) {
        let cut = text.lastIndexOf(' ', start + MAX_UTTERANCE_CHARS);
        if (cut <= start) cut = text.indexOf(' ', start + MAX_UTTERANCE_CHARS);
        if (cut < 0 || cut >= end) break;
        ranges.push([start, cut]);
        start = cut + 1;
    }
    ranges.push([start, end]);
    return ranges;
}

// Underline positions for the characters [start, end) of a page, as fractions of the page size.
// Position inside a text run is estimated from the character count, which is close enough for an underline.
function rangeRects(runs, start, end, pageWidth, pageHeight) {
    const rects = [];
    for (const run of runs) {
        const from = Math.max(start, run.start);
        const to = Math.min(end, run.start + run.length);
        if (from >= to) continue;
        const x = run.x + run.width * (from - run.start) / run.length;
        const width = run.width * (to - from) / run.length;
        const last = rects[rects.length - 1];
        const sameLine = last && Math.abs(last.bottom - run.bottom) < run.height * 0.4 && x >= last.x - run.height;
        if (sameLine) {
            last.width = Math.max(last.x + last.width, x + width) - last.x;
            last.top = Math.min(last.top, run.top);
        } else {
            rects.push({ x, width, top: run.top, bottom: run.bottom, height: run.height });
        }
    }
    return rects.map((rect) => ({
        x: rect.x / pageWidth,
        y: rect.top / pageHeight,
        w: rect.width / pageWidth,
        h: (rect.bottom - rect.top) / pageHeight,
    }));
}

// Split one page's text into sentence chunks with underline boxes. runs come from the text layer or OCR.
function chunksForPage(pageNumber, pageText, runs, size) {
    const pageResult = [];
    const sentenceRanges = [];
    let sentenceStart = 0;
    for (const separator of pageText.matchAll(/(?<=[.?!।])\s+/g)) {
        sentenceRanges.push([sentenceStart, separator.index]);
        sentenceStart = separator.index + separator[0].length;
    }
    sentenceRanges.push([sentenceStart, pageText.length]);

    for (const [rawStart, rawEnd] of sentenceRanges) {
        const [start, end] = trimRange(pageText, rawStart, rawEnd);
        if (end - start <= 2) continue;
        const lang = isDevanagari(pageText.slice(start, end)) ? 'hi' : 'en';
        for (const [partStart, partEnd] of splitLong(pageText, start, end)) {
            const text = pageText.slice(partStart, partEnd).trim().replace(/\s+/g, ' ');
            if (!text) continue;
            pageResult.push({
                page: pageNumber,
                text,
                lang,
                rects: rangeRects(runs, partStart, partEnd, size.width, size.height),
            });
        }
    }
    return pageResult;
}

async function extractSentences(pdf, generation) {
    const textChunks = [];
    const sizes = [];
    const damaged = new Set();
    const scanned = new Set();
    const hindiPages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        if (generation !== loadGeneration) return null;
        status.textContent = `Reading page ${pageNumber} of ${pdf.numPages}...`;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const size = { width: viewport.width, height: viewport.height };
        sizes.push(size);
        const content = await page.getTextContent();
        let pageText = '';
        const runs = [];
        for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            if (item.str.length) {
                const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const height = Math.hypot(matrix[2], matrix[3]) || item.height || 10;
                runs.push({
                    start: pageText.length,
                    length: item.str.length,
                    x: matrix[4],
                    width: item.width,
                    top: matrix[5] - height * 0.85,
                    bottom: matrix[5] + height * 0.22,
                    height,
                });
            }
            pageText += item.str;
            if (item.hasEOL) pageText += '\n';
        }
        if (ocr.isScannedPage(pageText)) scanned.add(pageNumber);
        else if (ocr.isDamagedHindi(pageText)) damaged.add(pageNumber);
        if (/[ऀ-ॿ]/.test(pageText)) hindiPages.push(pageNumber);
        textChunks.push(chunksForPage(pageNumber, pageText, runs, size));
        page.cleanup();
    }
    // Short pages (a cover, a heading) are too small to judge; if most of the book is damaged,
    // the same font is broken there too.
    if (damaged.size >= Math.max(2, hindiPages.length / 2)) {
        hindiPages.forEach((pageNumber) => { if (!scanned.has(pageNumber)) damaged.add(pageNumber); });
    }
    return { textChunks, sizes, damaged, scanned };
}

function needsOcr(pageNumber) {
    return damagedPages.has(pageNumber) || scannedPages.has(pageNumber);
}

// Damaged and scanned pages are read from the page image once OCR is downloaded; until a page
// is recognised it is a single placeholder that recognition replaces.
function chunksOfPage(pageNumber) {
    if (ocrReady && needsOcr(pageNumber)) {
        const lang = damagedPages.has(pageNumber) ? 'hi' : 'en';
        return ocrChunks.get(pageNumber) || [{ page: pageNumber, text: '', lang, rects: [], pending: true }];
    }
    return pageChunks[pageNumber - 1] || [];
}

function firstIndexOfPage(pageNumber) {
    return chunks.findIndex((chunk) => chunk.page >= pageNumber);
}

// Positions as { page, i } survive rebuilding, unlike flat indices.
function positionOf(index) {
    const chunk = chunks[index];
    if (!chunk) return { page: 1, i: 0 };
    return { page: chunk.page, i: index - firstIndexOfPage(chunk.page) };
}

function indexOfPosition({ page, i }) {
    const first = firstIndexOfPage(page);
    if (first < 0) return Math.max(0, chunks.length - 1);
    if (chunks[first].page !== page) return first;
    let index = first;
    while (index - first < i && index + 1 < chunks.length && chunks[index + 1].page === page) index++;
    return index;
}

// changedPage: clips for sentences on earlier pages keep their indices, so keep them.
function rebuildChunks(changedPage = 1) {
    const position = chunks.length ? positionOf(currentIndex) : null;
    for (const [index, clip] of clips) {
        if (chunks[index] && chunks[index].page < changedPage) continue;
        clip.cancel();
        clips.delete(index);
    }
    chunks = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) chunks.push(...chunksOfPage(pageNumber));
    if (position) currentIndex = indexOfPosition(position);
}

function recognizePage(pageNumber) {
    if (recognizing.has(pageNumber)) return recognizing.get(pageNumber);
    const generation = loadGeneration;
    const job = (async () => {
        try {
            const page = await pdfDocument.getPage(pageNumber);
            const damaged = damagedPages.has(pageNumber);
            let usedLangs = 'hin';
            const { text, runs } = await ocr.recognizePage(page, damaged ? 'hin' : () => (usedLangs = scanLangs));
            const result = chunksForPage(pageNumber, text, runs, pageSizes[pageNumber - 1]);
            if (generation !== loadGeneration) return;
            if (!damaged && usedLangs === 'eng+hin') scanLangs = ocr.languagesFromText(text) || scanLangs;
            // A blank scanned page gives nothing and is skipped (004-05).
            ocrChunks.set(pageNumber, result.length ? result : pageChunks[pageNumber - 1]);
        } catch (error) {
            if (generation !== loadGeneration) return;
            // Fall back to the damaged text rather than stopping (003-17).
            ocrChunks.set(pageNumber, pageChunks[pageNumber - 1]);
            damageNote.textContent = `Could not read page ${pageNumber} from the image (${error.message}). Reading its damaged text instead.`;
        }
        rebuildChunks(pageNumber);
        if (!running || paused) {
            showSentence(currentIndex, false);
            if (!running) stopButton.disabled = currentIndex === 0;
        }
    })();
    recognizing.set(pageNumber, job);
    return job;
}

// Recognise the next damaged page in the background while this one is read (003-12).
function recognizeAhead(pageNumber) {
    for (let next = pageNumber + 1; next <= Math.min(pageCount, pageNumber + 2); next++) {
        const first = chunks[firstIndexOfPage(next)];
        if (first && first.page === next && first.pending) {
            recognizePage(next);
            return;
        }
    }
}

function updateDamageNote() {
    damageNote.replaceChildren();
    if (!damagedPages.size && !scannedPages.size) return;
    const count = (n) => (n === 1 ? '1 page' : `${n} pages`);
    const problems = [];
    if (scannedPages.size) problems.push(`This PDF is a scanned copy (${count(scannedPages.size)} with no text).`);
    if (damagedPages.size) problems.push(`${scannedPages.size ? 'Its' : "This PDF's"} Hindi text is damaged on ${count(damagedPages.size)}.`);
    if (ocrReady) {
        damageNote.textContent = `${problems.join(' ')} Those pages are read from the page image.`;
        return;
    }
    damageNote.append(`${problems.join(' ')} Those pages can't be read correctly without page reading. `);
    if (!ocr.supported()) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Download page reading (${ocr.OCR_MEGABYTES} MB)`;
    button.addEventListener('click', () => settings.openOcr());
    damageNote.append(button);
}

function buildPages() {
    if (pageObserver) pageObserver.disconnect();
    renderedPages.clear();
    renderingPages.clear();
    markedSheet = null;
    pagesElement.replaceChildren();
    pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page));
        }
    }, { rootMargin: '800px 0px' });

    pageSizes.forEach((size, index) => {
        const sheet = document.createElement('div');
        sheet.className = 'page';
        sheet.id = `page-${index + 1}`;
        sheet.dataset.page = index + 1;
        sheet.style.aspectRatio = `${size.width} / ${size.height}`;
        const marks = document.createElement('div');
        marks.className = 'marks';
        sheet.append(marks);
        pagesElement.append(sheet);
        pageObserver.observe(sheet);
    });
}

async function renderPage(pageNumber) {
    if (renderedPages.has(pageNumber) || renderingPages.has(pageNumber)) return;
    const generation = loadGeneration;
    const sheet = document.getElementById(`page-${pageNumber}`);
    if (!sheet || !pdfDocument) return;
    renderingPages.add(pageNumber);
    try {
        const page = await pdfDocument.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const targetWidth = Math.min(sheet.clientWidth * (window.devicePixelRatio || 1), MAX_CANVAS_WIDTH);
        const viewport = page.getViewport({ scale: targetWidth / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // willReadFrequently keeps the canvas off the GPU, which sometimes drops parts of glyphs.
        const canvasContext = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        await page.render({ canvasContext, viewport }).promise;
        page.cleanup();
        if (generation !== loadGeneration) return;
        sheet.prepend(canvas);
        renderedPages.set(pageNumber, canvas);
        evictPages(pageNumber);
    } catch (error) {
        if (generation === loadGeneration) console.error(`Could not render page ${pageNumber}`, error);
    } finally {
        if (generation === loadGeneration) renderingPages.delete(pageNumber);
    }
}

// Phones run out of canvas memory on long PDFs, so keep only pages near the one just drawn.
function evictPages(keepNear) {
    while (renderedPages.size > MAX_RENDERED_PAGES) {
        let farthest = null;
        for (const pageNumber of renderedPages.keys()) {
            if (farthest === null || Math.abs(pageNumber - keepNear) > Math.abs(farthest - keepNear)) farthest = pageNumber;
        }
        const canvas = renderedPages.get(farthest);
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
        renderedPages.delete(farthest);
        // Re-observe so the page is drawn again when it scrolls back into view.
        const sheet = document.getElementById(`page-${farthest}`);
        pageObserver.unobserve(sheet);
        pageObserver.observe(sheet);
    }
}

function loadVoices() {
    voices = synth ? synth.getVoices() : [];
    updateVoiceNote();
}

function pickVoice(lang) {
    const preferences = lang === 'hi' ? ['hi-in', 'hi'] : ['en-in', 'en-gb', 'en-us', 'en'];
    for (const prefix of preferences) {
        const matches = voices.filter((voice) => voice.lang.replace('_', '-').toLowerCase().startsWith(prefix));
        if (matches.length) return matches.find((voice) => voice.localService) || matches[0];
    }
    return null;
}

function updateVoiceNote() {
    if (!synth) {
        voiceNote.textContent = 'This browser has no text-to-speech support. Open the app in Chrome.';
        return;
    }
    // Android often reports an empty list even though speech works, so only warn on a known gap.
    const missingHindi = voices.length > 0 && chunks.some((chunk) => chunk.lang === 'hi') && !settings.usePack('hi') && !pickVoice('hi');
    voiceNote.textContent = missingHindi
        ? 'No Hindi voice found on this device. Tap ⚙ to download the Pratham Hindi voice pack, or install one in Settings → Text-to-speech output → Install voice data → Hindi.'
        : '';
}

// Draw the underline under the sentence on the PDF page and keep it on screen.
function markSentence(chunk, follow) {
    if (markedSheet) markedSheet.querySelector('.marks').replaceChildren();
    const sheet = document.getElementById(`page-${chunk.page}`);
    markedSheet = sheet;
    if (!sheet) return;
    const marks = sheet.querySelector('.marks');
    for (const rect of chunk.rects) {
        const mark = document.createElement('div');
        mark.className = 'mark';
        mark.style.left = `${rect.x * 100}%`;
        mark.style.top = `${rect.y * 100}%`;
        mark.style.width = `${rect.w * 100}%`;
        mark.style.height = `${rect.h * 100}%`;
        marks.append(mark);
    }
    if (!follow) return;
    const first = marks.firstElementChild;
    if (!first) {
        sheet.scrollIntoView({ block: 'start' });
        return;
    }
    const box = first.getBoundingClientRect();
    const visibleTop = bar.offsetHeight;
    const visibleHeight = window.innerHeight - visibleTop;
    if (box.top < visibleTop + 8 || box.bottom > window.innerHeight - visibleHeight * 0.15) {
        window.scrollBy({ top: box.top - (visibleTop + visibleHeight * 0.3), behavior: 'smooth' });
    }
}

function showSentence(index, follow = true) {
    const chunk = chunks[index];
    currentIndex = index;
    status.textContent = chunk.pending
        ? `Page ${chunk.page} of ${pageCount} · Reading page image ${chunk.page}…`
        : `Page ${chunk.page} of ${pageCount} · Sentence ${index + 1} of ${chunks.length} · ${chunk.lang === 'hi' ? 'Hindi' : 'English'} · ${settings.voiceLabel(chunk.lang)}`;
    previousButton.disabled = index === 0;
    nextButton.disabled = index >= chunks.length - 1;
    markSentence(chunk, follow);
    savePosition(index);
}

function savePosition(index) {
    if (!positionKey) return;
    try {
        if (index > 0) localStorage.setItem(positionKey, JSON.stringify(positionOf(index)));
        else localStorage.removeItem(positionKey);
    } catch (error) { /* storage may be unavailable */ }
}

function savedPosition() {
    try {
        const saved = JSON.parse(localStorage.getItem(positionKey));
        // Older versions saved a plain sentence index.
        if (Number.isInteger(saved)) return saved > 0 && saved < chunks.length ? saved : 0;
        return saved && Number.isInteger(saved.page) ? indexOfPosition(saved) : 0;
    } catch (error) {
        return 0;
    }
}

function speak(index) {
    if (index >= chunks.length) {
        halt();
        status.textContent = 'Finished reading the document.';
        savePosition(0);
        currentIndex = 0;
        return;
    }
    showSentence(index);
    const token = ++speakToken;
    const chunk = chunks[index];
    if (chunk.pending) {
        // Recognise the page image first, then read from its first (or tapped) sentence.
        recognizePage(chunk.page).then(() => {
            if (token !== speakToken || !running || paused) return;
            // A page that gave no text is gone from chunks, so this is the next page (or the end).
            let target = firstIndexOfPage(chunk.page);
            if (target < 0) target = chunks.length;
            if (pendingTap && pendingTap.page === chunk.page) {
                const tapped = sentenceAt(pendingTap.page, pendingTap.x, pendingTap.y, pendingTap.aspect);
                if (tapped >= 0) target = tapped;
            }
            pendingTap = null;
            speak(target);
        });
        return;
    }
    recognizeAhead(chunk.page);
    if (settings.usePack(chunk.lang)) speakWithPack(index, token);
    else speakWithPhone(index, token);
}

function spokenText(chunk) {
    return speakable(chunk.text, chunk.lang, settings.lexicon(chunk.lang));
}

function speakWithPhone(index, token) {
    if (!synth) {
        halt();
        status.textContent = 'This browser has no text-to-speech. Tap ⚙ to download the Indian voice packs.';
        return;
    }
    const chunk = chunks[index];
    const utterance = new SpeechSynthesisUtterance(spokenText(chunk));
    const voice = pickVoice(chunk.lang);
    if (voice) utterance.voice = voice;
    utterance.lang = voice ? voice.lang.replace('_', '-') : (chunk.lang === 'hi' ? 'hi-IN' : 'en-IN');
    utterance.rate = Number(speed.value);
    utterance.onend = () => {
        if (token === speakToken && running && !paused) speak(index + 1);
    };
    utterance.onerror = (event) => {
        if (token !== speakToken || event.error === 'interrupted' || event.error === 'canceled') return;
        halt();
        status.textContent = `Could not speak sentence ${index + 1}: ${event.error}. Check the phone's text-to-speech settings.`;
    };
    // Keep a reference: Chrome can drop the end event if the utterance is garbage collected.
    currentUtterance = utterance;
    synth.speak(utterance);
}

function getClip(index) {
    if (!clips.has(index)) {
        const chunk = chunks[index];
        const clip = packs.synthesize(chunk.lang, spokenText(chunk), Number(speed.value));
        clip.promise.catch(() => clips.delete(index));
        clips.set(index, clip);
    }
    return clips.get(index).promise;
}

// Make the next sentence while this one plays, so there is no gap between them.
function prefetch(index) {
    if (index < chunks.length && !chunks[index].pending && settings.usePack(chunks[index].lang)) getClip(index).catch(() => {});
}

// Drop clips that are no longer near the sentence being read; cancelled ones are skipped by the worker.
function dropClips(keep = new Set()) {
    for (const [index, clip] of clips) {
        if (keep.has(index)) continue;
        clip.cancel();
        clips.delete(index);
    }
}

function stopPackAudio() {
    packPlayer.onended = null;
    packPlayer.pause();
}

async function speakWithPack(index, token) {
    const chunk = chunks[index];
    const ready = setTimeout(() => {
        if (token === speakToken) status.textContent += ' · preparing voice…';
    }, 400);
    try {
        const wav = await getClip(index);
        clearTimeout(ready);
        if (token !== speakToken || !running || paused) return;
        showSentence(index, false);
        if (packObjectUrl) URL.revokeObjectURL(packObjectUrl);
        packObjectUrl = URL.createObjectURL(wav);
        packPlayer.src = packObjectUrl;
        packPlayer.onended = () => {
            clips.delete(index);
            if (token === speakToken && running && !paused) speak(index + 1);
        };
        await packPlayer.play();
        prefetch(index + 1);
    } catch (error) {
        clearTimeout(ready);
        if (token !== speakToken || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') {
            pause();
            status.textContent = 'Tap Play to start the audio.';
            return;
        }
        // Read this sentence with the phone voice rather than stopping.
        voiceNote.textContent = `The ${packs.VOICE_PACKS[chunk.lang].name} voice pack failed (${error.message}). Using the phone voice for now.`;
        if (/engine|memory|WebAssembly/i.test(error.message)) settings.reportEngineError(error.message);
        speakWithPhone(index, token);
    }
}

// cancel() followed immediately by speak() is dropped on Android, so restart after a short delay.
function jumpTo(index, follow = true) {
    const token = ++speakToken;
    if (synth) synth.cancel();
    stopPackAudio();
    dropClips(new Set([index, index + 1]));
    showSentence(index, follow);
    if (!running || paused) return;
    setTimeout(() => {
        if (token === speakToken && running && !paused) speak(index);
    }, 120);
}

function begin(index = currentIndex, follow = true) {
    if (chunks.length === 0) return;
    running = true;
    paused = false;
    startButton.textContent = 'Pause';
    stopButton.disabled = false;
    requestWakeLock();
    jumpTo(index, follow);
}

function pause() {
    paused = true;
    speakToken++;
    if (synth) synth.cancel();
    stopPackAudio();
    startButton.textContent = 'Play';
    const chunk = chunks[currentIndex];
    status.textContent = chunk.pending
        ? `Paused · Page ${chunk.page} of ${pageCount}`
        : `Paused · Page ${chunk.page} of ${pageCount} · Sentence ${currentIndex + 1} of ${chunks.length} · ${settings.voiceLabel(chunk.lang)}`;
    releaseWakeLock();
}

function halt() {
    running = false;
    paused = false;
    speakToken++;
    if (synth) synth.cancel();
    stopPackAudio();
    dropClips();
    currentUtterance = null;
    startButton.textContent = 'Play';
    stopButton.disabled = true;
    releaseWakeLock();
}

// The sentence whose text is nearest to a tap on a page, or -1 if the tap was on empty space.
function sentenceAt(pageNumber, x, y, aspect) {
    let best = -1;
    let bestDistance = MAX_TAP_DISTANCE;
    chunks.forEach((chunk, index) => {
        if (chunk.page !== pageNumber) return;
        // A page not yet read from its image has no boxes; any tap on it starts there.
        if (chunk.pending) {
            best = index;
            bestDistance = -1;
            return;
        }
        for (const rect of chunk.rects) {
            const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
            const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h)) * aspect;
            const distance = Math.hypot(dx, dy);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        }
    });
    return best;
}

async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (error) { /* denied or unsupported; reading still works */ }
}

function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
}

async function openPdf(file) {
    const generation = ++loadGeneration;
    halt();
    chunks = [];
    pageChunks = [];
    damagedPages = new Set();
    scannedPages = new Set();
    scanLangs = 'eng+hin';
    ocrChunks.clear();
    recognizing.clear();
    pendingTap = null;
    damageNote.replaceChildren();
    positionKey = null;
    currentIndex = 0;
    startButton.disabled = true;
    previousButton.disabled = true;
    nextButton.disabled = true;
    empty.hidden = true;
    pagesElement.replaceChildren();
    voiceNote.textContent = '';
    status.textContent = 'Reading PDF...';
    if (pdfDocument) {
        pdfDocument.destroy();
        pdfDocument = null;
    }
    try {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        if (generation !== loadGeneration) { pdf.destroy(); return; }
        pdfDocument = pdf;
        const result = await extractSentences(pdf, generation);
        if (!result || generation !== loadGeneration) return;
        pageChunks = result.textChunks;
        pageSizes = result.sizes;
        damagedPages = result.damaged;
        scannedPages = result.scanned;
        pageCount = pdf.numPages;
        ocrReady = (damagedPages.size > 0 || scannedPages.size > 0) && await ocr.isDownloaded();
        if (generation !== loadGeneration) return;
        rebuildChunks();
        positionKey = `readaloud:position:${file.name}:${file.size}`;
        buildPages();
    } catch (error) {
        if (generation !== loadGeneration) return;
        empty.hidden = false;
        status.textContent = `Could not read this PDF: ${error.message}`;
        return;
    }

    if (chunks.length === 0) {
        // A scanned PDF without page reading: show the pages and offer the download (004-02).
        updateDamageNote();
        status.textContent = scannedPages.size
            ? 'This PDF is a scanned copy. Download page reading to read it aloud.'
            : 'No text found in this PDF.';
        return;
    }
    startButton.disabled = !synth && !packs.supported();
    const resumeAt = savedPosition();
    showSentence(resumeAt);
    stopButton.disabled = resumeAt === 0;
    updateVoiceNote();
    updateDamageNote();
    preloadPacks();
    // Start on the page the reader will hear first, so Play doesn't wait for it.
    if (chunks[resumeAt].pending) recognizePage(chunks[resumeAt].page);
}

fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) openPdf(file);
});

startButton.addEventListener('click', () => {
    if (running && !paused) pause();
    else begin();
});

stopButton.addEventListener('click', () => {
    halt();
    if (chunks.length) showSentence(0);
});

previousButton.addEventListener('click', () => {
    if (currentIndex > 0) jumpTo(currentIndex - 1);
});

nextButton.addEventListener('click', () => {
    if (currentIndex + 1 < chunks.length) jumpTo(currentIndex + 1);
});

// Tapping text on a page moves the underline there and reads on from that sentence.
pagesElement.addEventListener('click', (event) => {
    const sheet = event.target.closest('.page');
    if (!sheet || chunks.length === 0) return;
    const box = sheet.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const pageNumber = Number(sheet.dataset.page);
    const index = sentenceAt(pageNumber, x, y, box.height / box.width);
    if (index < 0) return;
    pendingTap = chunks[index].pending ? { page: pageNumber, x, y, aspect: box.height / box.width } : null;
    begin(index, false);
});

// The rate of an utterance or clip is fixed once it is made, so restart the sentence at the new speed.
speed.addEventListener('change', () => {
    dropClips();
    if (running && !paused) jumpTo(currentIndex, false);
});

// Load the voice packs this PDF needs into memory now, so the first sentence starts quickly.
function preloadPacks() {
    for (const lang of new Set(chunks.map((chunk) => chunk.lang))) {
        if (settings.usePack(lang)) packs.preload(lang).catch((error) => settings.reportEngineError(error.message));
    }
}

function testVoice(lang, text) {
    if (running && !paused) pause();
    if (synth) synth.cancel();
    stopPackAudio();
    if (settings.usePack(lang)) {
        packs.synthesize(lang, text, Number(speed.value)).promise.then((wav) => {
            if (packObjectUrl) URL.revokeObjectURL(packObjectUrl);
            packObjectUrl = URL.createObjectURL(wav);
            packPlayer.src = packObjectUrl;
            return packPlayer.play();
        }).catch((error) => alert(`Could not test the voice: ${error.message}`));
    } else if (synth) {
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickVoice(lang);
        if (voice) utterance.voice = voice;
        utterance.lang = voice ? voice.lang.replace('_', '-') : (lang === 'hi' ? 'hi-IN' : 'en-IN');
        utterance.rate = Number(speed.value);
        currentUtterance = utterance;
        synth.speak(utterance);
    }
}

const settings = initSettings({
    onChange: () => {
        dropClips();
        updateVoiceNote();
        if (!chunks.length) return;
        preloadPacks();
        if (running && !paused) jumpTo(currentIndex, false);
        else showSentence(currentIndex, false);
    },
    onTest: testVoice,
    // OCR was downloaded or deleted: switch damaged pages between page images and text.
    onOcrChange: async () => {
        ocrReady = (damagedPages.size > 0 || scannedPages.size > 0) && await ocr.isDownloaded();
        updateDamageNote();
        if (!pageCount) return;
        rebuildChunks();
        startButton.disabled = !chunks.length || (!synth && !packs.supported());
        if (!chunks.length) return;
        if (running && !paused) jumpTo(currentIndex, false);
        else {
            showSentence(currentIndex, false);
            if (chunks[currentIndex].pending) recognizePage(chunks[currentIndex].page);
        }
    },
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && !paused) requestWakeLock();
});

window.addEventListener('pagehide', () => {
    if (synth) synth.cancel();
    stopPackAudio();
});

if (synth) {
    synth.cancel();
    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
} else {
    updateVoiceNote();
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}
