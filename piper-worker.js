// Makes speech with the Piper voice packs off the main thread, so scrolling and buttons stay responsive.
// Messages in:  { type: 'load', lang, model }            -> { type: 'loaded', lang } or { type: 'error', lang, message }
//               { type: 'synth', id, lang, model, text, speed } -> { type: 'audio', id, wav } or { type: 'error', id, message }
//               { type: 'cancel', id }

importScripts('vendor/ort/ort.wasm.min.js', 'vendor/piper/piper_phonemize.js');

ort.env.wasm.wasmPaths = new URL('vendor/ort/', self.location).href;
// GitHub Pages can't send the headers multi-threaded WebAssembly needs.
ort.env.wasm.numThreads = 1;

const voices = new Map(); // lang -> Promise<{ session, config }>
const cancelled = new Set();
let phonemizer = null;
let phonemizerOutput = [];
let queue = Promise.resolve();

// Read straight from the voice cache, so it works offline even if the service worker isn't in control.
async function cachedFetch(url) {
    const cached = await caches.match(url);
    return cached || fetch(url);
}

function loadVoice(lang, model) {
    if (!voices.has(lang)) {
        const loading = (async () => {
            const [configResponse, modelResponse] = await Promise.all([cachedFetch(`${model}.json`), cachedFetch(model)]);
            if (!configResponse.ok || !modelResponse.ok) throw new Error('Voice pack is not downloaded');
            const config = await configResponse.json();
            const session = await ort.InferenceSession.create(new Uint8Array(await modelResponse.arrayBuffer()), {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });
            return { session, config };
        })();
        voices.set(lang, loading);
        loading.catch(() => voices.delete(lang));
    }
    return voices.get(lang);
}

async function phonemize(text, espeakVoice) {
    if (!phonemizer) {
        phonemizer = await createPiperPhonemize({
            noInitialRun: true,
            print: (line) => phonemizerOutput.push(line),
            printErr: (line) => console.warn('phonemize:', line),
            locateFile: (file) => `vendor/piper/${file}`,
        });
    }
    phonemizerOutput = [];
    phonemizer.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    const ids = [];
    for (const line of phonemizerOutput) ids.push(...JSON.parse(line).phoneme_ids);
    return ids;
}

function toWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

async function synthesize({ lang, model, text, speed }) {
    const { session, config } = await loadVoice(lang, model);
    const ids = await phonemize(text, config.espeak.voice);
    if (!ids.length) throw new Error('Nothing to say');
    const inference = config.inference;
    const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([ids.length], BigInt), [1]),
        // A smaller length scale speaks faster without raising the pitch.
        scales: new ort.Tensor('float32', Float32Array.from([inference.noise_scale, inference.length_scale / speed, inference.noise_w]), [3]),
    };
    if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const { output } = await session.run(feeds);
    return toWav(output.data, config.audio.sample_rate);
}

// Jobs run one at a time; a job cancelled while waiting is skipped.
function enqueue(task) {
    queue = queue.then(task, task);
}

self.onmessage = ({ data }) => {
    if (data.type === 'cancel') {
        cancelled.add(data.id);
    } else if (data.type === 'load') {
        enqueue(async () => {
            try {
                await loadVoice(data.lang, data.model);
                self.postMessage({ type: 'loaded', lang: data.lang });
            } catch (error) {
                self.postMessage({ type: 'error', lang: data.lang, message: error.message || String(error) });
            }
        });
    } else if (data.type === 'unload') {
        const loading = voices.get(data.lang);
        voices.delete(data.lang);
        if (loading) loading.then(({ session }) => session.release()).catch(() => {});
    } else if (data.type === 'synth') {
        enqueue(async () => {
            if (cancelled.delete(data.id)) {
                self.postMessage({ type: 'error', id: data.id, message: 'cancelled', cancelled: true });
                return;
            }
            try {
                const wav = await synthesize(data);
                self.postMessage({ type: 'audio', id: data.id, wav });
            } catch (error) {
                self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) });
            }
        });
    }
};
