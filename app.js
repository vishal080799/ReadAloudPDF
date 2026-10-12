import * as pdfjsLib from './vendor/pdf.min.mjs';

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
const empty = document.getElementById('empty');
const pagesElement = document.getElementById('pages');

let pdfDocument = null;
let loadGeneration = 0;
let chunks = [];
let pageCount = 0;
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

async function extractSentences(pdf, generation) {
    const allChunks = [];
    const pageSizes = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        if (generation !== loadGeneration) return null;
        status.textContent = `Reading page ${pageNumber} of ${pdf.numPages}...`;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
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
                allChunks.push({
                    page: pageNumber,
                    text,
                    lang,
                    rects: rangeRects(runs, partStart, partEnd, viewport.width, viewport.height),
                });
            }
        }
        page.cleanup();
    }
    return { allChunks, pageSizes };
}

function buildPages(pageSizes) {
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
    const missingHindi = voices.length > 0 && chunks.some((chunk) => chunk.lang === 'hi') && !pickVoice('hi');
    voiceNote.textContent = missingHindi
        ? 'No Hindi voice found on this device. Install it in Settings → Text-to-speech output → Install voice data → Hindi.'
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
    status.textContent = `Page ${chunk.page} of ${pageCount} · Sentence ${index + 1} of ${chunks.length} · ${chunk.lang === 'hi' ? 'Hindi' : 'English (India)'}`;
    previousButton.disabled = index === 0;
    nextButton.disabled = index >= chunks.length - 1;
    markSentence(chunk, follow);
    savePosition(index);
}

function savePosition(index) {
    if (!positionKey) return;
    try {
        if (index > 0) localStorage.setItem(positionKey, String(index));
        else localStorage.removeItem(positionKey);
    } catch (error) { /* storage may be unavailable */ }
}

function savedPosition() {
    try {
        const index = Number(localStorage.getItem(positionKey));
        return Number.isInteger(index) && index > 0 && index < chunks.length ? index : 0;
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
    const utterance = new SpeechSynthesisUtterance(chunk.text);
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

// cancel() followed immediately by speak() is dropped on Android, so restart after a short delay.
function jumpTo(index, follow = true) {
    const token = ++speakToken;
    synth.cancel();
    showSentence(index, follow);
    if (!running || paused) return;
    setTimeout(() => {
        if (token === speakToken && running && !paused) speak(index);
    }, 120);
}

function begin(index = currentIndex, follow = true) {
    if (!synth || chunks.length === 0) return;
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
    synth.cancel();
    startButton.textContent = 'Play';
    status.textContent = `Paused · Page ${chunks[currentIndex].page} of ${pageCount} · Sentence ${currentIndex + 1} of ${chunks.length}`;
    releaseWakeLock();
}

function halt() {
    running = false;
    paused = false;
    speakToken++;
    if (synth) synth.cancel();
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
        chunks = result.allChunks;
        pageCount = pdf.numPages;
        positionKey = `readaloud:position:${file.name}:${file.size}`;
        buildPages(result.pageSizes);
    } catch (error) {
        if (generation !== loadGeneration) return;
        empty.hidden = false;
        status.textContent = `Could not read this PDF: ${error.message}`;
        return;
    }

    if (chunks.length === 0) {
        status.textContent = 'No selectable text found. Scanned PDFs need OCR before they can be read aloud.';
        return;
    }
    startButton.disabled = !synth;
    const resumeAt = savedPosition();
    showSentence(resumeAt);
    stopButton.disabled = resumeAt === 0;
    updateVoiceNote();
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
    const index = sentenceAt(Number(sheet.dataset.page), x, y, box.height / box.width);
    if (index >= 0) begin(index, false);
});

// The rate of an utterance is fixed once it starts, so restart the sentence at the new speed.
speed.addEventListener('change', () => {
    if (running && !paused) jumpTo(currentIndex, false);
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && !paused) requestWakeLock();
});

window.addEventListener('pagehide', () => {
    if (synth) synth.cancel();
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
