import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const MAX_UTTERANCE_CHARS = 220;
const MAX_RENDERED_PAGES = 8;
const MAX_CANVAS_WIDTH = 1600;

const synth = window.speechSynthesis;
const fileInput = document.getElementById('file');
const reader = document.getElementById('reader');
const startButton = document.getElementById('start');
const previousButton = document.getElementById('previous');
const nextButton = document.getElementById('next');
const stopButton = document.getElementById('stop');
const speed = document.getElementById('speed');
const speedValue = document.getElementById('speed-value');
const meta = document.getElementById('meta');
const currentText = document.getElementById('current-text');
const status = document.getElementById('status');
const voiceNote = document.getElementById('voice-note');
const empty = document.getElementById('empty');
const pagesElement = document.getElementById('pages');
const readPanel = document.getElementById('read-panel');

let pdfDocument = null;
let loadGeneration = 0;
let chunks = [];
let pageCount = 0;
let positionKey = null;
let voices = [];
let running = false;
let paused = false;
let currentIndex = 0;
let currentPage = 0;
let speakToken = 0;
let currentUtterance = null;
let wakeLock = null;
let pageObserver = null;
const renderedPages = new Map();
const renderingPages = new Set();


function isDevanagari(text) {
    const devanagariCount = (text.match(/[ऀ-ॿ]/g) || []).length;
    const totalLetters = (text.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
    if (totalLetters === 0) return false;
    return devanagariCount / totalLetters > 0.4;
}

// Android speech engines cut off or reject very long utterances.
function splitLong(text) {
    if (text.length <= MAX_UTTERANCE_CHARS) return [text];
    const parts = [];
    let part = '';
    for (const word of text.split(' ')) {
        if (part && part.length + word.length + 1 > MAX_UTTERANCE_CHARS) {
            parts.push(part);
            part = word;
        } else {
            part = part ? `${part} ${word}` : word;
        }
    }
    if (part) parts.push(part);
    return parts;
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
        for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            pageText += item.str;
            if (item.hasEOL) pageText += '\n';
        }
        for (const sentence of pageText.split(/(?<=[.?!।])\s+/)) {
            const cleaned = sentence.trim().replace(/\s+/g, ' ');
            if (cleaned.length <= 2) continue;
            const lang = isDevanagari(cleaned) ? 'hi' : 'en';
            for (const text of splitLong(cleaned)) {
                allChunks.push({ page: pageNumber, text, lang });
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
    pagesElement.replaceChildren();
    pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page));
        }
    }, { rootMargin: '800px 0px' });

    pageSizes.forEach((size, index) => {
        const pageNumber = index + 1;
        const figure = document.createElement('figure');
        figure.className = 'page';
        figure.id = `page-${pageNumber}`;
        figure.dataset.page = pageNumber;
        const caption = document.createElement('figcaption');
        const label = document.createElement('span');
        label.textContent = `Page ${pageNumber} of ${pageSizes.length}`;
        caption.append(label);
        const firstIndex = chunks.findIndex((chunk) => chunk.page === pageNumber);
        if (firstIndex >= 0) {
            const readHere = document.createElement('button');
            readHere.type = 'button';
            readHere.textContent = 'Read from here';
            readHere.addEventListener('click', () => {
                currentPage = pageNumber;
                if (running && !paused) jumpTo(firstIndex);
                else { showSentence(firstIndex); begin(); }
            });
            caption.append(readHere);
        }
        const sheet = document.createElement('div');
        sheet.className = 'sheet';
        sheet.style.aspectRatio = `${size.width} / ${size.height}`;
        figure.append(caption, sheet);
        pagesElement.append(figure);
        pageObserver.observe(figure);
    });
}

async function renderPage(pageNumber) {
    if (renderedPages.has(pageNumber) || renderingPages.has(pageNumber)) return;
    const generation = loadGeneration;
    const sheet = document.querySelector(`#page-${pageNumber} .sheet`);
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
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        page.cleanup();
        if (generation !== loadGeneration) return;
        sheet.replaceChildren(canvas);
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
        const figure = document.getElementById(`page-${farthest}`);
        pageObserver.unobserve(figure);
        pageObserver.observe(figure);
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

function showSentence(index) {
    const chunk = chunks[index];
    currentIndex = index;
    meta.textContent = `Page ${chunk.page} of ${pageCount} · Sentence ${index + 1} of ${chunks.length} · ${chunk.lang === 'hi' ? 'Hindi' : 'English (India)'}`;
    currentText.textContent = chunk.text;
    currentText.scrollTop = 0;
    previousButton.disabled = index === 0;
    nextButton.disabled = index >= chunks.length - 1;
    if (chunk.page !== currentPage) {
        const page = document.getElementById(`page-${chunk.page}`);
        if (page) page.scrollIntoView({ block: 'start' });
        currentPage = chunk.page;
    }
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
    status.textContent = 'Reading aloud';
}

// cancel() followed immediately by speak() is dropped on Android, so restart after a short delay.
function jumpTo(index) {
    const token = ++speakToken;
    synth.cancel();
    showSentence(index);
    if (!running || paused) return;
    setTimeout(() => {
        if (token === speakToken && running && !paused) speak(index);
    }, 120);
}

function begin() {
    if (!synth || chunks.length === 0) return;
    running = true;
    paused = false;
    startButton.textContent = 'Pause';
    stopButton.disabled = false;
    requestWakeLock();
    jumpTo(currentIndex);
}

function pause() {
    paused = true;
    speakToken++;
    synth.cancel();
    startButton.textContent = 'Resume';
    status.textContent = 'Paused.';
    releaseWakeLock();
}

function halt() {
    running = false;
    paused = false;
    speakToken++;
    if (synth) synth.cancel();
    currentUtterance = null;
    startButton.textContent = 'Start reading';
    stopButton.disabled = true;
    releaseWakeLock();
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
    currentPage = 0;
    startButton.disabled = true;
    reader.hidden = true;
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
        status.textContent = 'No selectable text was found. This may be a scanned PDF; OCR is needed to read it aloud.';
        return;
    }
    reader.hidden = false;
    startButton.disabled = !synth;
    const resumeAt = savedPosition();
    showSentence(resumeAt);
    status.textContent = resumeAt ? `Ready. Continuing from sentence ${resumeAt + 1}; press Stop to go back to the beginning.` : 'Ready.';
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
    status.textContent = 'Stopped.';
});

previousButton.addEventListener('click', () => {
    if (currentIndex > 0) jumpTo(currentIndex - 1);
});

nextButton.addEventListener('click', () => {
    if (currentIndex + 1 < chunks.length) jumpTo(currentIndex + 1);
});

speed.addEventListener('input', () => {
    speedValue.value = `${Number(speed.value).toFixed(1)}x`;
});

// The rate of an utterance is fixed once it starts, so restart the sentence at the new speed.
speed.addEventListener('change', () => {
    if (running && !paused) jumpTo(currentIndex);
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && !paused) requestWakeLock();
});

window.addEventListener('pagehide', () => {
    if (synth) synth.cancel();
});

new ResizeObserver(() => {
    const sticky = getComputedStyle(readPanel).borderBottomWidth !== '0px';
    document.documentElement.style.setProperty('--bar-h', sticky ? `${readPanel.offsetHeight}px` : '0px');
}).observe(readPanel);

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
