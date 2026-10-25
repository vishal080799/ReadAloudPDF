// Indian voice packs (Piper): download into Cache Storage, delete, and speech via piper-worker.js.
// Voice packs live in their own cache so app updates (a new sw.js CACHE) never delete them.

const VOICE_CACHE = 'readaloud-voices-v1';

export const VOICE_PACKS = {
    hi: { name: 'Pratham', language: 'Hindi', model: 'voices/hi_IN-pratham-medium.onnx' },
    en: { name: 'Navgurukul', language: 'English (India)', model: 'voices/en_IN-navgurukul-medium.onnx' },
};

// Sizes are only used for the progress bar when the server sends no Content-Length.
const ENGINE_FILES = {
    'vendor/ort/ort.wasm.min.js': 142930,
    'vendor/ort/ort-wasm-simd.wasm': 10595041,
    'vendor/piper/piper_phonemize.js': 120714,
    'vendor/piper/piper_phonemize.wasm': 635212,
    'vendor/piper/piper_phonemize.data': 18077249,
};
const MODEL_BYTES = 63516050;
export const PACK_MEGABYTES = Math.round(MODEL_BYTES / 1e6);
export const ENGINE_MEGABYTES = Math.round(Object.values(ENGINE_FILES).reduce((sum, size) => sum + size, 0) / 1e6);

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }
const loading = new Map(); // lang -> { resolve, reject }

export function supported() {
    return 'caches' in self && typeof WebAssembly === 'object' && typeof Worker === 'function';
}

function packFiles(lang) {
    const model = VOICE_PACKS[lang].model;
    return { [`${model}.json`]: 5000, [model]: MODEL_BYTES };
}

export async function missingFiles(files) {
    const cache = await caches.open(VOICE_CACHE);
    const missing = [];
    for (const file of Object.keys(files)) {
        if (!(await cache.match(file))) missing.push(file);
    }
    return missing;
}

export async function isDownloaded(lang) {
    if (!supported()) return false;
    try {
        return (await missingFiles({ ...packFiles(lang), ...ENGINE_FILES })).length === 0;
    } catch (error) {
        return false;
    }
}

export async function engineDownloaded() {
    try {
        return (await missingFiles(ENGINE_FILES)).length === 0;
    } catch (error) {
        return false;
    }
}

// onProgress(receivedBytes, totalBytes). Pass an AbortSignal to cancel.
export function download(lang, onProgress, signal) {
    return downloadFiles({ ...packFiles(lang), ...ENGINE_FILES }, onProgress, signal);
}

// files: { path: expectedBytes }. Stores each missing file in the offline cache.
export async function downloadFiles(files, onProgress, signal) {
    const missing = await missingFiles(files);
    const cache = await caches.open(VOICE_CACHE);
    let total = missing.reduce((sum, file) => sum + files[file], 0);
    let received = 0;
    for (const file of missing) {
        const response = await fetch(file, { signal, cache: 'no-cache' });
        if (!response.ok) throw new Error(`${file} could not be downloaded (${response.status})`);
        const length = Number(response.headers.get('Content-Length'));
        if (length) total += length - files[file];
        const reader = response.body.getReader();
        const parts = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.length;
            onProgress(received, total);
        }
        const headers = { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' };
        await cache.put(file, new Response(new Blob(parts), { headers }));
    }
    onProgress(total, total);
}

export async function removeFiles(files) {
    const cache = await caches.open(VOICE_CACHE);
    await Promise.all(Object.keys(files).map((file) => cache.delete(file)));
}

export async function remove(lang) {
    if (worker) worker.postMessage({ type: 'unload', lang });
    const cache = await caches.open(VOICE_CACHE);
    await Promise.all(Object.keys(packFiles(lang)).map((file) => cache.delete(file)));
    const other = lang === 'hi' ? 'en' : 'hi';
    if ((await missingFiles(packFiles(other))).length) {
        await Promise.all(Object.keys(ENGINE_FILES).map((file) => cache.delete(file)));
    }
}

function failAll(message) {
    for (const { reject } of [...pending.values(), ...loading.values()]) reject(new Error(message));
    pending.clear();
    loading.clear();
    if (worker) worker.terminate();
    worker = null;
}

function getWorker() {
    if (worker) return worker;
    worker = new Worker('piper-worker.js');
    worker.onmessage = ({ data }) => {
        if (data.id !== undefined) {
            const job = pending.get(data.id);
            if (!job) return;
            pending.delete(data.id);
            if (data.type === 'audio') job.resolve(data.wav);
            else {
                const error = new Error(data.message);
                if (data.cancelled) error.name = 'AbortError';
                job.reject(error);
            }
        } else if (data.lang) {
            const job = loading.get(data.lang);
            if (!job) return;
            loading.delete(data.lang);
            if (data.type === 'loaded') job.resolve();
            else job.reject(new Error(data.message));
        }
    };
    // The worker script itself failed (no WebAssembly, out of memory, engine files missing offline).
    worker.onerror = (event) => {
        event.preventDefault();
        failAll(event.message || 'The voice engine could not start on this device');
    };
    return worker;
}

// Load a voice into memory ahead of time so the first sentence starts quickly.
export function preload(lang) {
    if (!loading.has(lang)) {
        const promise = new Promise((resolve, reject) => loading.set(lang, { resolve, reject }));
        promise.catch(() => {});
        getWorker().postMessage({ type: 'load', lang, model: VOICE_PACKS[lang].model });
        return promise;
    }
    return Promise.resolve();
}

// Returns { promise: Promise<Blob of WAV audio>, cancel() }.
export function synthesize(lang, text, speed) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    getWorker().postMessage({ type: 'synth', id, lang, model: VOICE_PACKS[lang].model, text, speed });
    return {
        promise,
        cancel: () => { if (worker && pending.has(id)) worker.postMessage({ type: 'cancel', id }); },
    };
}
