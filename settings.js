// The ⚙ settings dialog: a voice for each language, voice pack downloads, and the pronunciation list.
import * as packs from './voicepacks.js';
import * as ocr from './ocr.js';

const LANGS = ['hi', 'en'];
const LEXICON_KEY = 'readaloud:lexicon';

function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
}

function write(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* storage may be unavailable */ }
}

function loadLexicon() {
    try {
        const stored = JSON.parse(read(LEXICON_KEY));
        return { hi: Array.isArray(stored?.hi) ? stored.hi : [], en: Array.isArray(stored?.en) ? stored.en : [] };
    } catch (error) {
        return { hi: [], en: [] };
    }
}

function cleanEntries(entries) {
    return (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && typeof entry.word === 'string' && typeof entry.say === 'string' && entry.word.trim() && entry.say.trim())
        .map((entry) => ({ word: entry.word.trim(), say: entry.say.trim() }));
}

function mergeEntries(list, entries) {
    for (const entry of entries) {
        const existing = list.findIndex((item) => item.word.toLowerCase() === entry.word.toLowerCase());
        if (existing >= 0) list[existing] = entry;
        else list.push(entry);
    }
    list.sort((a, b) => a.word.localeCompare(b.word));
}

// onChange(): a setting that affects speech changed. onTest(lang, text): speak text with that language's voice.
// onOcrChange(): Hindi page reading was downloaded or deleted.
export function initSettings({ onChange, onTest, onOcrChange }) {
    const dialog = document.getElementById('settings');
    const downloaded = { hi: false, en: false };
    const downloads = {}; // lang -> AbortController
    const lexicon = loadLexicon();
    let engineError = null;

    const choice = (lang) => read(`readaloud:voice:${lang}`) || (downloaded[lang] ? 'pack' : 'phone');
    const usePack = (lang) => !engineError && choice(lang) === 'pack' && downloaded[lang];

    function renderVoice(lang) {
        const pack = packs.VOICE_PACKS[lang];
        const row = dialog.querySelector(`.voice-row[data-lang="${lang}"]`);
        const select = row.querySelector('select');
        const status = row.querySelector('.pack-status');
        const [downloadButton, cancelButton, deleteButton] = ['download', 'cancel', 'delete'].map((action) => row.querySelector(`[data-action="${action}"]`));
        const busy = Boolean(downloads[lang]);
        select.value = choice(lang);
        downloadButton.hidden = downloaded[lang] || busy;
        cancelButton.hidden = !busy;
        deleteButton.hidden = !downloaded[lang] || busy;
        row.querySelector('progress').hidden = !busy;
        if (busy) return;
        if (!packs.supported()) {
            status.textContent = 'Voice packs are not supported in this browser. Open the app in Chrome over https.';
            downloadButton.hidden = true;
        } else if (engineError) {
            status.textContent = `The voice pack can't run on this device (${engineError}). Using the phone voice.`;
        } else if (downloaded[lang]) {
            status.textContent = `${pack.name} is downloaded and works offline.`;
        } else {
            const engine = downloaded.hi || downloaded.en ? '' : ` + ${packs.ENGINE_MEGABYTES} MB speech engine`;
            status.textContent = `Not downloaded: ${packs.PACK_MEGABYTES} MB${engine}. Wi-Fi recommended. ${choice(lang) === 'pack' ? 'Using the phone voice until it is downloaded.' : ''}`;
        }
    }

    function renderLexicon() {
        const lang = document.getElementById('lexicon-lang').value;
        const list = document.getElementById('lexicon-list');
        list.replaceChildren();
        if (!lexicon[lang].length) {
            const empty = document.createElement('li');
            empty.className = 'hint';
            empty.textContent = 'No words yet.';
            list.append(empty);
        }
        lexicon[lang].forEach((entry, index) => {
            const item = document.createElement('li');
            const text = document.createElement('span');
            text.textContent = `${entry.word} → ${entry.say}`;
            const test = document.createElement('button');
            test.type = 'button';
            test.textContent = 'Test';
            test.addEventListener('click', () => onTest(lang, entry.say));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Delete';
            remove.setAttribute('aria-label', `Delete ${entry.word}`);
            remove.addEventListener('click', () => {
                lexicon[lang].splice(index, 1);
                saveLexicon();
            });
            item.append(text, test, remove);
            list.append(item);
        });
    }

    function saveLexicon() {
        write(LEXICON_KEY, JSON.stringify(lexicon));
        renderLexicon();
        onChange();
    }

    const ocrRow = dialog.querySelector('.ocr-row');
    let ocrDownloaded = false;
    let ocrDownload = null; // AbortController while downloading

    function renderOcr() {
        const status = ocrRow.querySelector('.ocr-status');
        const busy = Boolean(ocrDownload);
        ocrRow.querySelector('[data-action="download"]').hidden = ocrDownloaded || busy || !ocr.supported();
        ocrRow.querySelector('[data-action="cancel"]').hidden = !busy;
        ocrRow.querySelector('[data-action="delete"]').hidden = !ocrDownloaded || busy;
        ocrRow.querySelector('progress').hidden = !busy;
        if (busy) return;
        if (!ocr.supported()) status.textContent = 'Not supported in this browser.';
        else if (ocrDownloaded) status.textContent = 'Page reading (Hindi and English) is downloaded and works offline.';
        else status.textContent = `Page reading (Hindi and English): ${ocr.OCR_MEGABYTES} MB.`;
    }

    async function startOcrDownload() {
        const status = ocrRow.querySelector('.ocr-status');
        const progress = ocrRow.querySelector('progress');
        ocrDownload = new AbortController();
        renderOcr();
        try {
            await ocr.download((received, total) => {
                progress.value = total ? received / total : 0;
                status.textContent = `Downloading: ${(received / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`;
            }, ocrDownload.signal);
            ocrDownload = null;
            ocrDownloaded = true;
            renderOcr();
            onOcrChange();
        } catch (error) {
            ocrDownload = null;
            renderOcr();
            if (error.name !== 'AbortError') status.textContent = `Download failed: ${error.message}. Check the internet connection and try again.`;
        }
    }

    ocrRow.querySelector('[data-action="download"]').addEventListener('click', startOcrDownload);
    ocrRow.querySelector('[data-action="cancel"]').addEventListener('click', () => ocrDownload?.abort());
    ocrRow.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        await ocr.remove();
        ocrDownloaded = false;
        renderOcr();
        onOcrChange();
    });

    async function refresh() {
        await Promise.all(LANGS.map(async (lang) => { downloaded[lang] = await packs.isDownloaded(lang); }));
        LANGS.forEach(renderVoice);
        ocrDownloaded = await ocr.isDownloaded();
        renderOcr();
    }

    async function startDownload(lang) {
        const row = dialog.querySelector(`.voice-row[data-lang="${lang}"]`);
        const progress = row.querySelector('progress');
        const status = row.querySelector('.pack-status');
        const controller = new AbortController();
        downloads[lang] = controller;
        renderVoice(lang);
        try {
            await packs.download(lang, (received, total) => {
                progress.value = total ? received / total : 0;
                status.textContent = `Downloading ${packs.VOICE_PACKS[lang].name}: ${(received / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB (${total ? Math.floor(received / total * 100) : 0}%)`;
            }, controller.signal);
            delete downloads[lang];
            downloaded[lang] = true;
            if (!read(`readaloud:voice:${lang}`)) write(`readaloud:voice:${lang}`, 'pack');
            // The other row's size changes too: the speech engine is now downloaded.
            LANGS.forEach(renderVoice);
            onChange();
        } catch (error) {
            delete downloads[lang];
            renderVoice(lang);
            if (error.name !== 'AbortError') {
                status.textContent = `Download failed: ${error.message}. Check the internet connection and try again. Using the phone voice.`;
            }
        }
    }

    for (const lang of LANGS) {
        const row = dialog.querySelector(`.voice-row[data-lang="${lang}"]`);
        row.querySelector('select').addEventListener('change', (event) => {
            write(`readaloud:voice:${lang}`, event.target.value);
            renderVoice(lang);
            onChange();
        });
        row.querySelector('[data-action="download"]').addEventListener('click', () => startDownload(lang));
        row.querySelector('[data-action="cancel"]').addEventListener('click', () => downloads[lang]?.abort());
        row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            await packs.remove(lang);
            await refresh();
            onChange();
        });
    }

    document.getElementById('settings-button').addEventListener('click', () => {
        refresh();
        renderLexicon();
        dialog.showModal();
    });
    document.getElementById('settings-close').addEventListener('click', () => dialog.close());
    document.getElementById('lexicon-lang').addEventListener('change', renderLexicon);

    const wordInput = document.getElementById('lexicon-word');
    const sayInput = document.getElementById('lexicon-say');
    document.getElementById('lexicon-test').addEventListener('click', () => {
        const text = sayInput.value.trim() || wordInput.value.trim();
        if (text) onTest(document.getElementById('lexicon-lang').value, text);
    });
    document.getElementById('lexicon-add').addEventListener('click', () => {
        const entries = cleanEntries([{ word: wordInput.value, say: sayInput.value }]);
        if (!entries.length) return;
        mergeEntries(lexicon[document.getElementById('lexicon-lang').value], entries);
        wordInput.value = '';
        sayInput.value = '';
        saveLexicon();
    });
    document.getElementById('lexicon-export').addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([JSON.stringify(lexicon, null, 2)], { type: 'application/json' }));
        link.download = 'readaloud-pronunciation.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    document.getElementById('lexicon-import').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
            const imported = JSON.parse(await file.text());
            for (const lang of LANGS) mergeEntries(lexicon[lang], cleanEntries(imported[lang]));
            saveLexicon();
        } catch (error) {
            alert(`Could not import this file: ${error.message}`);
        }
    });

    refresh().then(onChange);

    return {
        usePack,
        // Open ⚙ at the Damaged PDFs section (from the damaged-text note).
        openOcr() {
            refresh();
            renderLexicon();
            dialog.showModal();
            document.getElementById('ocr-section').scrollIntoView({ block: 'start' });
        },
        lexicon: (lang) => lexicon[lang === 'hi' ? 'hi' : 'en'],
        voiceLabel: (lang) => (usePack(lang) ? packs.VOICE_PACKS[lang].name : 'phone voice'),
        reportEngineError(message) {
            engineError = message;
            LANGS.forEach(renderVoice);
        },
    };
}
