/*
    Runs ML inference outside the AudioWorklet thread.
*/

self.importScripts('/static/js/stft-tools.js');
self.importScripts('/static/js/fft.js/real.js');
self.importScripts('/static/js/fft.js/complex.js');
self.importScripts('/static/js/preprocessors.js');
self.importScripts('/static/js/ort.min.js');

const state = {
    ready: false,
    initializing: false,

    masking: true,
    outputSelection: 'full',
    bypassOnModelError: true,

    backlogPolicy: 'drop-old', // 'drop-old' | 'queue'
    busy: false,
    pendingMlFrame: null,
    queue: [],

    // Config
    name: null,
    hop_length: 0,
    input_shape: null,
    inputs: 0,
    modelFeatureInputs: 0,
    model_path: null,
    n_fft: 0,
    new_input_shape: null,
    state_input_shapes: null,
    state_output_shapes: null,
    name_of_outputs: [],
    name_of_inputs: [],
    outputs: 0,
    outputMode: 'mask',
    pad_size: 0,
    win_size: 0,

    // Preprocessing pipeline: an ordered list of stages
    preprocessingStages: [],
    timeDomainStages: [],
    spectralStages: [],

    // In-progress delay calibration capture, or null when idle.
    calibration: null,

    // Ports
    mlPort: null,
    specPort: null,
    specReferencePort: null,
    specPreprocessedPort: null,
    specProcessedPort: null,
    statusPort: null,

    // ONNX
    executionProvider: null,
    executionProviderReason: null,
    disableWebGPU: false,
    forceWasm: false,
    session: null,
    stateInputs: [],
    stateInputShapes: [],
    stateOutputShapes: [],

    // Chunked model inference
    chunk_size: 1,
    lookahead: 0,
    lookaheadFrames: 0,
    configChunkSize: null,
    input_shapes: null,
    modelInputShapes: [],
    framesPerInput: [],

    // Ring buffer for model inputs
    chunkFrameCapacity: 1,
    chunkFrameCount: 0,
    chunkFrameWritePos: 0,
    modelInputFrameRing: [],

    // For chunked mask mode: store the corresponding base spectra per frame
    maskBaseFrameRing: [],
    maskBaseFrameCount: 0,
    maskBaseFrameWritePos: 0,

    // Output queue of enhanced per-frame spectra waiting for synthesis
    modelOutputFrameQueue: [],

    // Packed chunk inputs reused for ONNX
    packedModelInputs: [],


    // STFT
    stftTools: null,
    inputStreams: [],
    inputSpectra: [],
    outputStream: null,
    outputBlock: null,
    frontendType: 'stft',
    frontendReal: true,

    modelInputSpectra: [],

    inputNorm: null,

    // Reusable buffers
    preprocessedSpectrum: null,
    echoSpectrum: null,
    enhancedSpectrum: null,
    identityMask: null,
    // Divisor that maps this frontend's magnitudes onto "1.0 == full-scale sine".
    specRefMag: 1,

    specView: null,
    specReferenceView: null,
    specPreprocessedView: null,
    specProcessedView: null,
    enhancedSpecView: null,

    // Persistent ONNX feeds (allocation-free steady state)
    feeds: null,
    inputTensors: null,

    // Diagnostics
    framesReceived: 0,
    framesProcessed: 0,
    framesDropped: 0,
    inferenceErrors: 0,
    lastStatusTs: 0,

    // Split timing probe (compute vs. total per-frame worker time).
    // Accumulated per ~1 s status window, then averaged and reset.
    timing: true,
    tRunSum: 0, tRunMax: 0, tRunCount: 0,      // time inside session.run()
    tFrameSum: 0, tFrameMax: 0, tFrameCount: 0, // time for the whole processOne()

    // Timing / profiling - GPT 5.4
    profiling: true,
    profileEveryNFrames: 200,

    tProcessFrameTotal: 0,
    tInputStft: 0,
    tBuildModelInputs: 0,
    tChunkEnqueue: 0,
    tChunkPack: 0,
    tModelRun: 0,
    tChunkOutput: 0,
    tSynthesis: 0,
    _tFeeds: 0,
    _tSession: 0,
    _tCopyBack: 0,

    profileFramesAccumulated: 0
};

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------

function nowMs() {
    return performance.now();
}

function resetProfilingStats() {
    state.tProcessFrameTotal = 0;
    state.tInputStft = 0;
    state.tBuildModelInputs = 0;
    state.tChunkEnqueue = 0;
    state.tChunkPack = 0;
    state.tModelRun = 0;
    state.tChunkOutput = 0;
    state.tSynthesis = 0;
    state.profileFramesAccumulated = 0;
}

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`MLWorker: ${msg}`);
    }
}

function postStatus(msg) {
    if (!state.statusPort) return;
    try {
        state.statusPort.postMessage(msg);
    } catch (_) {
        // ignore
    }
}

function recordRunTime(ms) {
    if (!state.timing) return;
    state.tRunSum += ms;
    state.tRunCount++;
    if (ms > state.tRunMax) state.tRunMax = ms;
}

function recordFrameTime(ms) {
    if (!state.timing) return;
    state.tFrameSum += ms;
    state.tFrameCount++;
    if (ms > state.tFrameMax) state.tFrameMax = ms;
}

function maybePostProfilingStatus() {
    if (!state.profiling) return;
    if (state.profileFramesAccumulated <= 0) return;
    if ((state.framesProcessed % state.profileEveryNFrames) !== 0) return;

    const n = state.profileFramesAccumulated;

    const summary = {
        type: 'profiling',
        source: 'ml-worker',
        frames: n,
        avg_ms_total: state.tProcessFrameTotal / n,
        avg_ms_input_stft: state.tInputStft / n,
        avg_ms_build_model_inputs: state.tBuildModelInputs / n,
        avg_ms_chunk_enqueue: state.tChunkEnqueue / n,
        avg_ms_chunk_pack: state.tChunkPack / n,
        avg_ms_model_run: state.tModelRun / n,
        avg_ms_chunk_output: state.tChunkOutput / n,
        avg_ms_synthesis: state.tSynthesis / n,
        chunk_size: state.chunk_size,
        output_mode: state.outputMode,
        masking: state.masking
    };

    console.log('[ml-worker profiling]', summary);

    if (state.statusPort) {
        state.statusPort.postMessage(summary);
    }

    resetProfilingStats();
}

function maybePostPeriodicStatus() {
    const now = Date.now();
    if (now - state.lastStatusTs < 1000) return;
    state.lastStatusTs = now;

    // Split timing summary for this window (ms). runMs = compute inside
    // session.run(); frameMs = whole worker frame. If runMs ~= frameMs the
    // model is compute-bound (-> quantization); if runMs << frameMs the cost
    // is per-run overhead / JS DSP (-> feeds reuse, fixed shapes, mask LUT).
    const runAvg = state.tRunCount ? state.tRunSum / state.tRunCount : 0;
    const frameAvg = state.tFrameCount ? state.tFrameSum / state.tFrameCount : 0;
    const runMax = state.tRunMax;
    const frameMax = state.tFrameMax;

    if (state.timing && state.tFrameCount > 0) {
        console.log(
            `[ml-timing] run avg=${runAvg.toFixed(2)}ms max=${runMax.toFixed(2)}ms | ` +
            `frame avg=${frameAvg.toFixed(2)}ms max=${frameMax.toFixed(2)}ms | ` +
            `run/frame=${frameAvg ? (100 * runAvg / frameAvg).toFixed(0) : '0'}% | ` +
            `frames=${state.tFrameCount}`
        );
    }

    postStatus({
        type: 'stats',
        source: 'ml-worker',
        ready: state.ready,
        busy: state.busy,
        framesReceived: state.framesReceived,
        framesProcessed: state.framesProcessed,
        framesDropped: state.framesDropped,
        queueLength: state.queue.length,
        hasPending: !!state.pendingMlFrame,
        inferenceErrors: state.inferenceErrors,
        masking: state.masking,
        outputSelection: state.outputSelection,
        backlogPolicy: state.backlogPolicy,
        chunkSize: state.chunk_size,
        lookahead: state.lookahead,
        runMsAvg: runAvg,
        runMsMax: runMax,
        frameMsAvg: frameAvg,
        frameMsMax: frameMax
    });

    // Reset window accumulators.
    state.tRunSum = 0; state.tRunMax = 0; state.tRunCount = 0;
    state.tFrameSum = 0; state.tFrameMax = 0; state.tFrameCount = 0;
}

function product(shape) {
    let p = 1;
    for (let i = 0; i < shape.length; ++i) p *= shape[i];
    return p;
}

function cloneFloat32(src) {
    const out = new Float32Array(src.length);
    out.set(src);
    return out;
}

function cloneInputFrameArray(inputData, expectedInputs, hopLength) {
    assert(Array.isArray(inputData), 'inputData must be an array');
    assert(inputData.length >= expectedInputs, `expected ${expectedInputs} input streams`);

    const out = new Array(expectedInputs);
    for (let i = 0; i < expectedInputs; ++i) {
        const src = inputData[i];
        assert(src instanceof Float32Array, `input stream ${i} must be Float32Array`);
        assert(src.length === hopLength, `input stream ${i} length must be ${hopLength}, got ${src.length}`);

        const copy = new Float32Array(hopLength);
        copy.set(src);
        out[i] = copy;
    }
    return out;
}

function fillIdentityMask(mask) {
    mask.fill(1.0);
    return mask;
}

// The spectrogram panels want energy, not Re{X}: drawing the real part alone
// blacks out every bin whose phase happens to be negative, which is what made
// the panels look sparse and thin. Scaled by the frontend's calibrated
// reference so 1.0 means "a full-scale sine" for every model, whatever gain
// the frontend's window carries, so the display's dB window means the same
// thing across a model switch.
function copyMagnitudeForDisplay(modelFrame, padSize, nFft, out) {
    const bins = (nFft >> 1) + 1;
    const imagOffset = (modelFrame.length >> 1) + padSize;
    const scale = 1 / (state.specRefMag || 1);

    for (let k = 0; k < bins; ++k) {
        const re = modelFrame[padSize + k];
        const im = modelFrame[imagOffset + k];
        out[k] = Math.sqrt(re * re + im * im) * scale;
    }

    return out;
}

function copySpectrumInto(src, dst) {
    assert(src.length === dst.length, `spectrum length mismatch: ${src.length} != ${dst.length}`);
    dst.set(src);
    return dst;
}

function validateOutputMode() {
    assert(
        state.outputMode === 'mask' || state.outputMode === 'direct',
        `unsupported output_mode: ${state.outputMode}`
    );
}

const PREPROCESSOR_DOMAIN = {
    delay_compensation: 'time',
    diffusion_noise: 'spectral'
};

const SAMPLE_RATE = 16000;
const MAX_DELAY_MS = 2000; // sane upper bound for a static per-device delay
const MAX_DELAY_SAMPLES = Math.round(MAX_DELAY_MS * SAMPLE_RATE / 1000);

// Accepts either a single legacy preprocessing object or an array of stages
function normalizePreprocessingStages(rawPreprocessing) {
    if (!rawPreprocessing) return [];
    return Array.isArray(rawPreprocessing) ? rawPreprocessing : [rawPreprocessing];
}

function resolveDelaySamples(stageConfig) {
    if (Number.isFinite(stageConfig.delaySamples)) {
        return Math.max(0, stageConfig.delaySamples | 0);
    }
    const delayMs = Number.isFinite(stageConfig.delayMs) ? stageConfig.delayMs : 0;
    return Math.max(0, Math.round(delayMs * SAMPLE_RATE / 1000));
}

// Named outputs each spectral preprocessor type may produce. 'enhanced' is
// every type's primary output, addressable via the legacy singular
// `enhancedInputIndex` field for backward compatibility; other names are only
// reachable via the newer `outputs: { name: modelFeatureInputIndex }` map.
const STAGE_OUTPUT_NAMES = {
    diffusion_noise: ['enhanced']
};

// Normalizes a stage's output routing to a canonical { name: index } map,
// computed once so every later consumer (validation, buildModelInputs, the
// debug-panel index) reads only this form and never branches on config shape.
function resolveStageOutputs(stage) {
    if (stage.outputs && typeof stage.outputs === 'object' && !Array.isArray(stage.outputs)) {
        return stage.outputs;
    }

    const legacyIdx = stage.enhancedInputIndex ?? state.inputs;
    // A multi-output map belongs under `outputs`, not the singular legacy
    // field -- catch that swap here with a message pointing at the fix,
    // instead of letting it surface later as an opaque "invalid index".
    assert(
        Number.isInteger(legacyIdx),
        `preprocessing stage "${stage.type}" has a non-numeric enhancedInputIndex ` +
        `(${JSON.stringify(stage.enhancedInputIndex)}). For multiple named outputs, use ` +
        `"outputs": { "enhanced": N, "echo": M } instead of putting that map under "enhancedInputIndex".`
    );

    return { enhanced: legacyIdx };
}

function validatePreprocessingConfig() {
    for (const stage of state.preprocessingStages) {
        if (!stage.enabled) continue;

        const domain = PREPROCESSOR_DOMAIN[stage.type];
        assert(domain, `unsupported preprocessing type: ${stage.type}`);

        if (domain === 'time') {
            const channelIndex = stage.channelIndex ?? 1;
            assert(
                channelIndex >= 0 && channelIndex < state.inputs,
                'invalid preprocessing channelIndex'
            );

            const delaySamples = resolveDelaySamples(stage);
            assert(
                delaySamples >= 0 && delaySamples <= MAX_DELAY_SAMPLES,
                `invalid preprocessing delay (${delaySamples} samples, max ${MAX_DELAY_SAMPLES})`
            );
        } else {
            const micIdx = stage.micInputIndex ?? 0;
            const refIdx = stage.refInputIndex ?? 1;

            assert(micIdx >= 0 && micIdx < state.modelFeatureInputs, 'invalid preprocessing micInputIndex');
            assert(refIdx >= 0 && refIdx < state.modelFeatureInputs, 'invalid preprocessing refInputIndex');

            const outputs = stage.outputs || {};
            const outputNames = Object.keys(outputs);
            assert(outputNames.length > 0, `preprocessing stage "${stage.type}" declares no outputs`);

            const allowedOutputs = STAGE_OUTPUT_NAMES[stage.type] || ['enhanced'];
            for (const outName of outputNames) {
                assert(
                    allowedOutputs.includes(outName),
                    `preprocessing stage "${stage.type}" does not support output "${outName}"`
                );
                const idx = outputs[outName];
                assert(
                    Number.isInteger(idx) && idx >= 0 && idx < state.modelFeatureInputs,
                    `invalid preprocessing outputs.${outName} index for stage "${stage.type}"`
                );
            }
        }
    }
}

function validateModelInputCount() {
    assert(
        state.name_of_inputs.length >= state.modelFeatureInputs,
        'name_of_inputs shorter than modelFeatureInputs'
    );

    const expectedStateInputs = state.name_of_inputs.length - state.modelFeatureInputs;
    assert(
        expectedStateInputs >= 0,
        'modelFeatureInputs exceeds total ONNX inputs'
    );
}

function normalizeStateShapes() {
    const totalStateInputs = state.name_of_inputs.length - state.modelFeatureInputs;
    const totalStateOutputs = state.name_of_outputs.length - state.outputs;

    // New format: explicit per-state shapes
    if (Array.isArray(state.state_input_shapes) && state.state_input_shapes.length > 0) {
        assert(
            state.state_input_shapes.length === totalStateInputs,
            `state_input_shapes length (${state.state_input_shapes.length}) does not match number of state inputs (${totalStateInputs})`
        );
        state.stateInputShapes = state.state_input_shapes.map(shape => shape.slice());
    } else if (state.new_input_shape) {
        // Old format: one shared shape for all states
        state.stateInputShapes = [];
        for (let i = 0; i < totalStateInputs; ++i) {
            state.stateInputShapes.push(state.new_input_shape.slice());
        }
    } else {
        state.stateInputShapes = [];
    }

    if (Array.isArray(state.state_output_shapes) && state.state_output_shapes.length > 0) {
        assert(
            state.state_output_shapes.length === totalStateOutputs,
            `state_output_shapes length (${state.state_output_shapes.length}) does not match number of state outputs (${totalStateOutputs})`
        );
        state.stateOutputShapes = state.state_output_shapes.map(shape => shape.slice());
    } else if (state.new_input_shape) {
        // Legacy fallback: assume output states have same shape as input states
        state.stateOutputShapes = [];
        for (let i = 0; i < totalStateOutputs; ++i) {
            state.stateOutputShapes.push(state.new_input_shape.slice());
        }
    } else {
        state.stateOutputShapes = [];
    }

    assert(
        state.stateInputShapes.length === totalStateInputs,
        `normalized state input shape count (${state.stateInputShapes.length}) does not match expected state input count (${totalStateInputs})`
    );

    assert(
        state.stateOutputShapes.length === totalStateOutputs,
        `normalized state output shape count (${state.stateOutputShapes.length}) does not match expected state output count (${totalStateOutputs})`
    );
}


// ------------------------------------------------------------
// Initialization
// ------------------------------------------------------------

function configureOrtWasmEnv() {
    // Single-core, low-latency streaming configuration.
    // We deliberately pin numThreads = 1 so no threaded wasm binary and no
    // COOP/COEP cross-origin isolation are required; SIMD is the main kernel win.
    ort.env.wasm.wasmPaths = '/static/js/';
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
}

function hasWebGPUSupport() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}

async function createWasmSession(modelUrl) {
    configureOrtWasmEnv();

    return await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        enableMemPattern: true,
        enableCpuMemArena: true
    });
}

async function createWebGPUSession(modelUrl) {
    return await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        enableMemPattern: true,
        enableCpuMemArena: true
    });
}

async function createSession(modelUrl, options = {}) {
    const disableWebGPU = !!options.disableWebGPU;
    const forceWasm = !!options.forceWasm;

    // Always configure the WASM environment so fallback is ready.
    configureOrtWasmEnv();

    if (forceWasm) {
        const session = await createWasmSession(modelUrl);
        state.executionProvider = 'wasm';
        state.executionProviderReason = 'forceWasm';
        return session;
    }

    if (disableWebGPU) {
        const session = await createWasmSession(modelUrl);
        state.executionProvider = 'wasm';
        state.executionProviderReason = 'disableWebGPU';
        return session;
    }

    if (hasWebGPUSupport()) {
        try {
            const session = await createWebGPUSession(modelUrl);
            state.executionProvider = 'webgpu';
            state.executionProviderReason = 'available';
            return session;
        } catch (err) {
            console.warn('WebGPU session creation failed, falling back to WASM:', err);
        }
    }

    const session = await createWasmSession(modelUrl);
    state.executionProvider = 'wasm';
    state.executionProviderReason = hasWebGPUSupport() ? 'webgpuFailed' : 'webgpuUnavailable';
    return session;
}

// Consecutive windows overlap by `lookahead` and advance by `chunk`
function initChunking() {
    const modelFrameLen = state.stftTools.getModelFrameLength();

    const primaryFrames = (Array.isArray(state.input_shape) && state.input_shape.length >= 4)
        ? state.input_shape[3]
        : 1;

    state.lookahead = Number.isInteger(state.lookaheadFrames) ? state.lookaheadFrames : 0;
    if (state.lookahead < 0) {
        throw new Error(`Invalid lookahead: ${state.lookahead}`);
    }

    // chunk_size explicit if the config says so
    state.chunk_size = Number.isInteger(state.configChunkSize)
        ? state.configChunkSize
        : (primaryFrames - state.lookahead);

    if (!Number.isInteger(state.chunk_size) || state.chunk_size < 1) {
        throw new Error(
            `Invalid chunk_size (${state.chunk_size}) from input_shape ${JSON.stringify(state.input_shape)} ` +
            `and lookahead ${state.lookahead}`
        );
    }

    // Frames each feature input expects, defaulting to the primary shape.
    state.framesPerInput = [];
    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        const shape = Array.isArray(state.input_shapes) ? state.input_shapes[i] : null;
        const n = (Array.isArray(shape) && shape.length >= 4) ? shape[3] : primaryFrames;

        if (!Number.isInteger(n) || n < 1) {
            throw new Error(`Invalid frame count ${n} for model input ${i}`);
        }
        if (n !== state.chunk_size && n !== state.chunk_size + state.lookahead) {
            throw new Error(
                `Model input ${i} wants ${n} frames; expected ${state.chunk_size} ` +
                `(output-aligned) or ${state.chunk_size + state.lookahead} (with lookahead)`
            );
        }
        state.framesPerInput.push(n);
    }

    state.modelInputShapes = [];
    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        const shape = Array.isArray(state.input_shapes) ? state.input_shapes[i] : null;
        state.modelInputShapes.push(
            (Array.isArray(shape) && shape.length >= 4) ? shape.slice() : state.input_shape.slice()
        );
    }

    // Hold a whole window; after a run only the `lookahead` overlap is kept.
    state.chunkFrameCapacity = state.chunk_size + state.lookahead;
    state.chunkFrameCount = 0;
    state.chunkFrameWritePos = 0;

    // Ring buffer: modelInputFrameRing[inputIdx][slot]
    state.modelInputFrameRing = [];
    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        const ring = [];
        for (let k = 0; k < state.chunkFrameCapacity; ++k) {
            ring.push(new Float32Array(modelFrameLen));
        }
        state.modelInputFrameRing.push(ring);
    }

    // Ring buffer for base spectra needed by mask-mode chunking
    state.maskBaseFrameRing = [];
    for (let k = 0; k < state.chunkFrameCapacity; ++k) {
        state.maskBaseFrameRing.push(new Float32Array(modelFrameLen));
    }
    state.maskBaseFrameCount = 0;
    state.maskBaseFrameWritePos = 0;

    state.modelOutputFrameQueue = [];

    state.packedModelInputs = [];
    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        state.packedModelInputs.push(
            new Float32Array(modelFrameLen * state.framesPerInput[i])
        );
    }
}


async function initializeWorker(name, config) {
    if (state.initializing || state.ready) return;
    state.initializing = true;

    try {
        assert(config, 'missing config');
        state.name = name;

        state.hop_length = config.hop_size;
        state.input_shape = config.input_shape;
        state.input_shapes = Array.isArray(config.input_shapes) ? config.input_shapes : null;
        state.configChunkSize = Number.isInteger(config.chunk_size) ? config.chunk_size : null;
        state.lookaheadFrames = Number.isInteger(config.lookahead) ? config.lookahead : 0;
        state.inputs = config.inputs;
        state.modelFeatureInputs = config.model_feature_inputs || config.inputs;
        state.model_path = config.model_path;
        state.n_fft = config.n_fft;
        state.new_input_shape = config.new_input_shape || null;
        state.state_input_shapes = config.state_input_shapes || null;
        state.state_output_shapes = config.state_output_shapes || null;
        state.name_of_outputs = config.name_of_outputs;
        state.name_of_inputs = config.name_of_inputs;
        state.outputs = config.outputs;
        state.outputMode = config.output_mode || 'mask';
        state.pad_size = config.pad_size;
        state.win_size = config.win_size;

        state.windowType = config.window || 'sqrt_hann';
        state.windowPeriodic = (config.window_periodic !== undefined)
            ? !!config.window_periodic
            : true;

        state.frontendType = config.frontend_type || 'stft';
        state.frontendReal = (config.real !== undefined) ? !!config.real : true;

        state.outputMode = config.output_mode || 'mask';
        state.inputNormalization = config.input_normalization || null;
        state.preprocessingStages = normalizePreprocessingStages(config.preprocessing);
        for (const stage of state.preprocessingStages) {
            if (PREPROCESSOR_DOMAIN[stage.type] === 'spectral') {
                stage.outputs = resolveStageOutputs(stage);
            }
        }

        state.processingUi = config.processing_ui || {};
        state.outputSelection = 'full';
        state.preprocessingSignificant = state.preprocessingStages.some(
            (s) => s.enabled && s.significant
        );

        // Last enabled spectral stage's primary (enhanced) output -- never the
        // echo estimate, even when a stage produces both.
        state.preprocessedOutputIndex = -1;
        for (const s of state.preprocessingStages) {
            if (s.enabled && PREPROCESSOR_DOMAIN[s.type] === 'spectral') {
                state.preprocessedOutputIndex = s.outputs.enhanced;
            }
        }

        // state.profiling = !!config.profiling;
        // state.profileEveryNFrames = config.profile_every_n_frames || 200;

        state.disableWebGPU = !!config.disable_webgpu;
        state.forceWasm = !!config.force_wasm;

        const modelUrl = state.model_path || `/static/models/${name}.onnx`;
        state.session = await createSession(modelUrl, {
            disableWebGPU: state.disableWebGPU,
            forceWasm: state.forceWasm
        });

        initStft();
        initInputNormalization();
        validateOutputMode();
        validatePreprocessingConfig();
        validateModelInputCount();
        normalizeStateShapes();
        initModelState();
        initReusableBuffers();
        initChunking();

        resetProfilingStats();

        state.ready = true;
        state.initializing = false;

        postStatus({
            type: 'ready',
            source: 'ml-worker',
            name: state.name,
            executionProvider: state.executionProvider,
            executionProviderReason: state.executionProviderReason
        });

        self.postMessage({
            type: 'ready',
            name: state.name,
            executionProvider: state.executionProvider
        });
    } catch (err) {
        state.initializing = false;
        console.error('Worker initialization failed:', err);
        postStatus({
            type: 'error',
            source: 'ml-worker',
            stage: 'initialize',
            message: String(err)
        });
        self.postMessage({
            type: 'error',
            stage: 'initialize',
            message: String(err)
        });
    }
}

function initStft() {
    const winSize = state.win_size;

    state.stftTools = new STFT_Tools(
        state.n_fft,
        winSize,
        state.hop_length,
        state.pad_size,
        false,
        false,
        {
            sampleRate: 16000,
            length: 32000,
            includeFFTCore: true,
            testOpts: {
                waveformTol: 1e-3,
                rmsTol: 1e-4,
                gainTol: 1e-2,
                corrTol: 0.999,
                maxAllowedDelay: Math.max(winSize, 512),
                maxLag: Math.max(winSize * 2, 1024),
                trimStart: winSize,
                trimEnd: winSize
            }
        },
        state.windowType,
        state.windowPeriodic,
        state.frontendType,
        state.frontendReal
    );

    state.inputStreams = [];
    state.inputSpectra = [];

    for (let i = 0; i < state.inputs; ++i) {
        state.inputStreams.push(state.stftTools.createStream());
        state.inputSpectra.push(new Float32Array(state.stftTools.getModelFrameLength()));
    }

    state.outputStream = state.stftTools.createStream();
    state.outputBlock = new Float32Array(state.stftTools.getHopLength());

    state.specRefMag = calibrateSpectrumReference();
}

// Peak bin magnitude of a full-scale sine pushed through this exact frontend.
// Cheaper and far more robust than hardcoding a gain per window type / os
// factor / prototype filter, and it runs once per model load.
function calibrateSpectrumReference() {
    const PRIME_FRAMES = 32;
    const MEASURE_FRAMES = 32;

    try {
        const hop = state.stftTools.getHopLength();
        const bins = (state.n_fft >> 1) + 1;
        const stream = state.stftTools.createStream();
        const frame = new Float32Array(state.stftTools.getModelFrameLength());
        const block = new Float32Array(hop);
        const imagOffset = (frame.length >> 1) + state.pad_size;

        let peak = 0;
        let n = 0;

        for (let f = 0; f < PRIME_FRAMES + MEASURE_FRAMES; ++f) {
            for (let i = 0; i < hop; ++i, ++n) {
                block[i] = Math.sin((2 * Math.PI * 1000 * n) / SAMPLE_RATE);
            }

            stream.processFrame(block, frame);
            if (f < PRIME_FRAMES) continue;

            for (let k = 0; k < bins; ++k) {
                const re = frame[state.pad_size + k];
                const im = frame[imagOffset + k];
                const mag = Math.sqrt(re * re + im * im);
                if (mag > peak) peak = mag;
            }
        }

        return peak > 0 ? peak : 1;
    } catch (err) {
        console.warn('Spectrogram reference calibration failed, using 1:', err);
        return 1;
    }
}


// ------------------------------------------------------------
// Input level normalization
// ------------------------------------------------------------
//
// Config (absent => disabled, so existing models are unaffected):
//   "input_normalization": {
//     "enabled": true,
//     "level_db": -26.0,        target RMS in dBFS
//     "zero_mean": true,        remove DC before measuring, as in training
//     "ref": "both",            "both" = per-stream gain, "noisy" = mic gain for all
//     "time_constant_s": 1.0,   smoothing of the level estimate
//     "denormalize_output": true
//   }
function initInputNormalization() {
    const cfg = state.inputNormalization;

    if (!cfg || !cfg.enabled) {
        state.inputNorm = null;
        return;
    }

    const levelDb = (cfg.level_db !== undefined) ? cfg.level_db : -26.0;
    const tc = (cfg.time_constant_s !== undefined) ? cfg.time_constant_s : 1.0;
    const fs = 16000;

    // One-pole coefficient for the mean-square estimate, per hop.
    const alpha = tc > 0 ? Math.exp(-state.hop_length / (tc * fs)) : 0.0;

    state.inputNorm = {
        level: Math.pow(10, levelDb / 20),
        zeroMean: cfg.zero_mean !== false,
        perStream: (cfg.ref || 'both') !== 'noisy',
        denormalizeOutput: cfg.denormalize_output !== false,
        eps: 1e-5,
        alpha,
        // running mean and mean-square per input stream
        mean: new Float64Array(state.inputs),
        meanSq: new Float64Array(state.inputs),
        primed: false,
        gains: new Float64Array(state.inputs),
        micGain: 1.0
    };

    state.inputNorm.gains.fill(1.0);
}

function resetInputNormalization() {
    const n = state.inputNorm;
    if (!n || !n.denormalizeOutput) return;
    n.mean.fill(0);
    n.meanSq.fill(0);
    n.gains.fill(1.0);
    n.micGain = 1.0;
    n.primed = false;
}

function applyInputNormalization(inputData) {
    const n = state.inputNorm;
    if (!n || !n.denormalizeOutput) return;

    const len = state.hop_length;

    for (let i = 0; i < state.inputs; ++i) {
        const buf = inputData[i];

        let sum = 0.0;
        let sumSq = 0.0;
        for (let k = 0; k < len; ++k) {
            const v = buf[k];
            sum += v;
            sumSq += v * v;
        }

        const frameMean = n.zeroMean ? (sum / len) : 0.0;
        // Variance about the running mean, matching the training-time
        // "subtract mean, then take the std" definition.
        const frameMeanSq = Math.max(0, sumSq / len - frameMean * frameMean);

        if (!n.primed) {
            n.mean[i] = frameMean;
            n.meanSq[i] = frameMeanSq;
        } else {
            n.mean[i] = n.alpha * n.mean[i] + (1 - n.alpha) * frameMean;
            n.meanSq[i] = n.alpha * n.meanSq[i] + (1 - n.alpha) * frameMeanSq;
        }

        n.gains[i] = n.level / Math.max(Math.sqrt(n.meanSq[i]), n.eps);
    }

    n.primed = true;

    for (let i = 0; i < state.inputs; ++i) {
        const g = n.perStream ? n.gains[i] : n.gains[0];
        const m = n.zeroMean ? n.mean[i] : 0.0;
        const buf = inputData[i];
        for (let k = 0; k < len; ++k) {
            buf[k] = (buf[k] - m) * g;
        }
    }

    n.micGain = n.perStream ? n.gains[0] : n.gains[0];
}

function denormalizeOutputBlock(block) {
    const n = state.inputNorm;
    if (!n || !n.denormalizeOutput) return;

    const inv = 1.0 / Math.max(n.micGain, 1e-12);
    for (let k = 0; k < block.length; ++k) {
        block[k] *= inv;
    }
}

function initModelState() {
    // Force persistent feeds/tensors to be rebuilt against the fresh buffers.
    state.feeds = null;
    state.inputTensors = null;

    state.stateInputs = [];

    const totalStateInputs = state.name_of_inputs.length - state.modelFeatureInputs;

    assert(
        state.stateInputShapes.length === totalStateInputs,
        `stateInputShapes length (${state.stateInputShapes.length}) does not match expected state input count (${totalStateInputs})`
    );

    for (let i = 0; i < totalStateInputs; ++i) {
        const shape = state.stateInputShapes[i];
        const size = product(shape);
        state.stateInputs.push(new Float32Array(size));
    }
}


function initReusableBuffers() {
    const modelFrameLen = state.stftTools.getModelFrameLength();
    const specBins = (state.n_fft >> 1) + 1;

    state.enhancedSpectrum = new Float32Array(modelFrameLen);
    state.preprocessedSpectrum  = new Float32Array(modelFrameLen);
    state.echoSpectrum = new Float32Array(modelFrameLen);
    state.identityMask = fillIdentityMask(new Float32Array(modelFrameLen));
    state.specView = new Float32Array(specBins);
    state.specProcessedView = new Float32Array(specBins);
    state.enhancedSpecView = new Float32Array(specBins);
    state.specReferenceView = new Float32Array(specBins);
    state.specPreprocessedView = new Float32Array(specBins);

    state.modelInputSpectra = [];
    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        state.modelInputSpectra.push(new Float32Array(modelFrameLen));
    }

    initPreprocessingStages(modelFrameLen);
}

function createPreprocessorInstance(stageConfig, modelFrameLen) {
    const domain = PREPROCESSOR_DOMAIN[stageConfig.type];

    if (domain === 'time') {
        assert(typeof DelayCompensator === 'function', 'DelayCompensator is not available');
        return new DelayCompensator({
            channelIndex: stageConfig.channelIndex ?? 1,
            delaySamples: resolveDelaySamples(stageConfig),
            hopLength: state.hop_length
        });
    }

    if (stageConfig.type === 'diffusion_noise') {
        assert(
            typeof DiffusionNoiseGenerator === 'function',
            'DiffusionNoiseGenerator is not available'
        );
        return new DiffusionNoiseGenerator({
            modelFrameLength: modelFrameLen,
            scale: stageConfig.scale || 1.0,
            seed: stageConfig.seed ?? null,
            stftTools: state.stftTools,
            hopLength: state.hop_length
        });
    }

    throw new Error(`Unknown preprocessing type: ${stageConfig.type}`);
}

// Instantiates one processor per enabled stage and caches domain-filtered
// views so the hot path doesn't re-filter every frame.
function initPreprocessingStages(modelFrameLen) {
    for (const stage of state.preprocessingStages) {
        stage.instance = stage.enabled ? createPreprocessorInstance(stage, modelFrameLen) : null;
    }

    state.timeDomainStages = state.preprocessingStages.filter(
        (s) => s.enabled && PREPROCESSOR_DOMAIN[s.type] === 'time'
    );
    state.spectralStages = state.preprocessingStages.filter(
        (s) => s.enabled && PREPROCESSOR_DOMAIN[s.type] === 'spectral'
    );
}

function resetStreamingState() {
    for (let i = 0; i < state.inputStreams.length; ++i) {
        state.inputStreams[i].reset();
    }

    if (state.outputStream) state.outputStream.reset();

    for (let i = 0; i < state.stateInputs.length; ++i) {
        state.stateInputs[i].fill(0);
    }

    for (let i = 0; i < state.modelInputSpectra.length; ++i) {
        state.modelInputSpectra[i].fill(0);
    }

    for (const stage of state.preprocessingStages) {
        if (stage.instance) stage.instance.reset();
    }
    if (state.preprocessedSpectrum) state.preprocessedSpectrum.fill(0);
    if (state.echoSpectrum) state.echoSpectrum.fill(0);

    resetInputNormalization();

    if (state.enhancedSpectrum) state.enhancedSpectrum.fill(0);
    if (state.outputBlock) state.outputBlock.fill(0);

    state.chunkFrameCount = 0;
    state.chunkFrameWritePos = 0;
    state.maskBaseFrameCount = 0;
    state.maskBaseFrameWritePos = 0;

    if (state.modelInputFrameRing) {
        for (let i = 0; i < state.modelInputFrameRing.length; ++i) {
            for (let k = 0; k < state.modelInputFrameRing[i].length; ++k) {
                state.modelInputFrameRing[i][k].fill(0);
            }
        }
    }

    if (state.maskBaseFrameRing) {
        for (let k = 0; k < state.maskBaseFrameRing.length; ++k) {
            state.maskBaseFrameRing[k].fill(0);
        }
    }

    if (state.modelOutputFrameQueue) {
        state.modelOutputFrameQueue.length = 0;
    }

    resetProfilingStats();

    state.pendingMlFrame = null;
    state.queue.length = 0;
    state.busy = false;
    state.calibration = null;
}

// ------------------------------------------------------------
// Masking
// ------------------------------------------------------------

// Layout: [pad][real][pad][imag]
function applyMaskInto(signalFft, mask, out) {
    const len = signalFft.length;
    const half = len >> 1;

    for (let i = 0; i < half; ++i) {
        const mr = mask[i];
        const mi = mask[half + i];
        const sr = signalFft[i];
        const si = signalFft[half + i];

        const mag = Math.hypot(mr, mi);

        let gain = 0.0;
        if (mag > 1e-12) {
            gain = Math.tanh(mag) * (mr / mag);
        }

        out[i] = gain * sr;
        out[half + i] = gain * si;
    }

    return out;
}

// ------------------------------------------------------------
// ONNX
// ------------------------------------------------------------

// Build the feeds object and input Tensors once, then reuse them every frame.
// A Tensor is only (re)created when its backing Float32Array identity changes
// (first call, or after the defensive state-buffer reallocation below), so the
// steady state is allocation-free. session.run() still copies the backing
// arrays into the wasm heap, so writing new samples in place is sufficient.
function ensurePersistentFeeds(inputArray) {
    if (!state.feeds) {
        state.feeds = {};
        state.inputTensors = new Array(state.name_of_inputs.length);
    }

    for (let i = 0; i < state.name_of_inputs.length; ++i) {
        const name = state.name_of_inputs[i];

        let data, shape;
        if (i < state.modelFeatureInputs) {
            data = inputArray[i];
            // Per-input: with lookahead these are not all the same length.
            shape = state.modelInputShapes[i];
        } else {
            const stateIdx = i - state.modelFeatureInputs;
            data = state.stateInputs[stateIdx];
            shape = state.stateInputShapes[stateIdx];
        }

        const existing = state.inputTensors[i];
        if (!existing || existing.data !== data) {
            const t = new ort.Tensor('float32', data, shape);
            state.inputTensors[i] = t;
            state.feeds[name] = t;
        }
    }
}

async function runModel(inputArray) {
    let output = null;
    let t1 = 0;

    try {
        
        if (state.profiling) t1 = nowMs();
        ensurePersistentFeeds(inputArray);
        const tFeeds = state.profiling ? (nowMs() - t1) : 0;

        if (state.profiling) t1 = nowMs();
        const t0 = state.timing ? performance.now() : 0;
        const results = await state.session.run(state.feeds);
        const tSession = state.profiling ? (nowMs() - t1) : 0;
        if (state.timing) recordRunTime(performance.now() - t0);


        if (state.profiling) t1 = nowMs();
        for (let i = 0; i < state.name_of_outputs.length; ++i) {
            const name = state.name_of_outputs[i];
            const data = results[name].data;

            if (i < state.outputs) {
                output = data;
            } else {
                const stateIdx = i - state.outputs;

                if (state.stateInputs[stateIdx].length !== data.length) {
                    // Defensive fallback in case output-state size differs.
                    state.stateInputs[stateIdx] = new Float32Array(data.length);
                }
                state.stateInputs[stateIdx].set(data);
            }
        }
        const tCopyBack = state.profiling ? (nowMs() - t1) : 0;

        if (state.profiling) {
            state.tModelRun += (tFeeds + tSession + tCopyBack);
            state._tFeeds = (state._tFeeds || 0) + tFeeds;
            state._tSession = (state._tSession || 0) + tSession;
            state._tCopyBack = (state._tCopyBack || 0) + tCopyBack;
        }
    } catch (err) {
        state.inferenceErrors++;
        console.error('ONNX inference failed:', err);
        postStatus({
            type: 'error',
            source: 'ml-worker',
            stage: 'inference',
            message: String(err)
        });
    }

    return output;
}

// ------------------------------------------------------------
// Chunking
// ------------------------------------------------------------

function packFrameChunkNCHW(frameList, freqBins, chunkSize, out) {
    // frameList[t] has shape [2*F], layout: [real(F), imag(F)]
    // out represents flattened [1, 2, F, T] in row-major order

    let idx = 0;

    // channel 0: real
    for (let f = 0; f < freqBins; ++f) {
        for (let t = 0; t < chunkSize; ++t) {
            out[idx++] = frameList[t][f];
        }
    }

    // channel 1: imag
    for (let f = 0; f < freqBins; ++f) {
        for (let t = 0; t < chunkSize; ++t) {
            out[idx++] = frameList[t][freqBins + f];
        }
    }

    return out;
}

function unpackFrameChunkNCHW(chunkData, freqBins, chunkSize) {
    const frames = [];
    for (let t = 0; t < chunkSize; ++t) {
        frames.push(new Float32Array(2 * freqBins));
    }

    let idx = 0;

    // channel 0: real
    for (let f = 0; f < freqBins; ++f) {
        for (let t = 0; t < chunkSize; ++t) {
            frames[t][f] = chunkData[idx++];
        }
    }

    // channel 1: imag
    for (let f = 0; f < freqBins; ++f) {
        for (let t = 0; t < chunkSize; ++t) {
            frames[t][freqBins + f] = chunkData[idx++];
        }
    }

    return frames;
}

function enqueueModelInputFrames(modelInputs, maskBaseSpectrum) {
    const pos = state.chunkFrameWritePos;

    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        state.modelInputFrameRing[i][pos].set(modelInputs[i]);
    }

    state.maskBaseFrameRing[pos].set(maskBaseSpectrum);

    if (state.chunkFrameCount < state.chunkFrameCapacity) {
        state.chunkFrameCount++;
    } else {
        // Overwrite oldest if ever overfilled; normally should not happen if consumed promptly.
        // Keep count saturated.
    }

    state.chunkFrameWritePos = (state.chunkFrameWritePos + 1) % state.chunkFrameCapacity;

    if (state.maskBaseFrameCount < state.chunkFrameCapacity) {
        state.maskBaseFrameCount++;
    }
    state.maskBaseFrameWritePos = state.chunkFrameWritePos;
}

// A full window is chunk + lookahead frames (== capacity).
function isModelChunkReady() {
    return state.chunkFrameCount >= state.chunkFrameCapacity;
}

// Oldest frame of the current window.
function windowStartPos() {
    const cap = state.chunkFrameCapacity;
    return (state.chunkFrameWritePos - state.chunkFrameCount + cap) % cap;
}

// Inputs sized to the chunk (the noise) take the output-aligned prefix; inputs
// sized to the window (mic, far-end) take the whole thing.
function getChunkFramesForInput(inputIdx) {
    const frames = [];
    const cap = state.chunkFrameCapacity;
    const start = windowStartPos();
    const n = state.framesPerInput[inputIdx];

    for (let k = 0; k < n; ++k) {
        frames.push(state.modelInputFrameRing[inputIdx][(start + k) % cap]);
    }

    return frames;
}

// Mask mode multiplies the model output by the frame it belongs to, which is
// the output-aligned prefix, never the lookahead context.
function getChunkMaskBaseFrames() {
    const frames = [];
    const cap = state.chunkFrameCapacity;
    const start = windowStartPos();

    for (let k = 0; k < state.chunk_size; ++k) {
        frames.push(state.maskBaseFrameRing[(start + k) % cap]);
    }

    return frames;
}

function buildPackedModelChunk() {
    const freqBins = (state.n_fft >> 1) + 1;

    for (let i = 0; i < state.modelFeatureInputs; ++i) {
        const frames = getChunkFramesForInput(i);
        packFrameChunkNCHW(frames, freqBins, state.framesPerInput[i], state.packedModelInputs[i]);
    }

    return state.packedModelInputs;
}

// Only the chunk is consumed; the lookahead tail stays as the next window's head.
function consumeInputChunkFrames() {
    state.chunkFrameCount = Math.max(0, state.chunkFrameCount - state.chunk_size);
    state.maskBaseFrameCount = Math.max(0, state.maskBaseFrameCount - state.chunk_size);
}

function enqueueDirectOutputChunk(modelOutputChunk) {
    const freqBins = (state.n_fft >> 1) + 1;
    const frames = unpackFrameChunkNCHW(modelOutputChunk, freqBins, state.chunk_size);

    for (let i = 0; i < frames.length; ++i) {
        state.modelOutputFrameQueue.push(frames[i]);
    }
}

function enqueueMaskOutputChunk(maskOutputChunk) {
    const freqBins = (state.n_fft >> 1) + 1;
    const maskFrames = unpackFrameChunkNCHW(maskOutputChunk, freqBins, state.chunk_size);
    const baseFrames = getChunkMaskBaseFrames();

    for (let i = 0; i < state.chunk_size; ++i) {
        const enhanced = new Float32Array(baseFrames[i].length);
        applyMaskInto(baseFrames[i], maskFrames[i], enhanced);
        state.modelOutputFrameQueue.push(enhanced);
    }
}

function dequeueEnhancedFrameOrFallback(fallbackFrame) {
    if (state.modelOutputFrameQueue.length > 0) {
        return state.modelOutputFrameQueue.shift();
    }
    return fallbackFrame;
}

// ------------------------------------------------------------
// Processing
// ------------------------------------------------------------

function buildModelInputs() {
    for (let i = 0; i < state.inputs; ++i) {
        state.modelInputSpectra[i].set(state.inputSpectra[i]);
    }

    // copy raw if no spectral-domain preprocessing stage is active
    if (state.spectralStages.length === 0) {
        if (state.preprocessedSpectrum) {
            state.preprocessedSpectrum.set(state.inputSpectra[0]);
        }
        return state.modelInputSpectra;
    }

    // Each stage runs independently against the raw mic/ref spectra and writes
    // each of its named outputs into its own configured model-input slot.
    for (const stage of state.spectralStages) {
        const micIdx = stage.micInputIndex ?? 0;
        const refIdx = stage.refInputIndex ?? 1;
        const update = stage.update ?? true;
        const outputs = stage.outputs;
        const needsEcho = outputs.echo !== undefined;

        try {
            state.modelInputSpectra[micIdx].set(state.inputSpectra[0])
            state.modelInputSpectra[refIdx].set(state.inputSpectra[1])

            stage.instance.applyModelFrames(
                state.inputSpectra[0],
                state.inputSpectra[1],
                state.preprocessedSpectrum,
                update,
                needsEcho ? state.echoSpectrum : undefined
            );

            // NOTE: the preprocessed spectrum is posted to its spectrogram panel
            // once per frame in processOne(), after modelInputSpectra[outputs.enhanced]
            // has been updated below. Do not post it here as well: it would both
            // double the frame rate (panel scrolls 2x too fast) and send stale data
            // (the enhanced slot is only filled at the assignment just below).

            if (outputs.enhanced !== undefined && outputs.enhanced < state.modelInputSpectra.length) {
                state.modelInputSpectra[outputs.enhanced].set(state.preprocessedSpectrum);
            }
            if (needsEcho && outputs.echo < state.modelInputSpectra.length) {
                state.modelInputSpectra[outputs.echo].set(state.echoSpectrum);
            }
        } catch (err) {
            console.error('Preprocessing failed:', err);
            postStatus({
                type: 'error',
                source: 'ml-worker',
                stage: 'preprocessing',
                message: String(err)
            });

            // Fallback: enhanced slot gets mic passthrough; echo slot (if
            // configured) is zeroed rather than left stale, since a leftover
            // echo estimate from a prior frame would actively mislead the
            // model on the next inference.
            state.preprocessedSpectrum.set(state.inputSpectra[0]);
            if (outputs.enhanced !== undefined && outputs.enhanced < state.modelInputSpectra.length) {
                state.modelInputSpectra[outputs.enhanced].set(state.preprocessedSpectrum);
            }
            if (needsEcho && outputs.echo < state.modelInputSpectra.length) {
                state.echoSpectrum.fill(0);
                state.modelInputSpectra[outputs.echo].set(state.echoSpectrum);
            }
        }
    }

    return state.modelInputSpectra;
}

// ------------------------------------------------------------
// Delay calibration
// ------------------------------------------------------------

function captureCalibrationHop(inputData) {
    const cal = state.calibration;
    const remaining = cal.targetLen - cal.writePos;
    if (remaining <= 0) return;

    const n = Math.min(remaining, inputData[0].length);
    cal.micBuf.set(inputData[0].subarray(0, n), cal.writePos);
    cal.refBuf.set(inputData[1].subarray(0, n), cal.writePos);
    cal.writePos += n;

    if (cal.writePos >= cal.targetLen) {
        finishCalibration();
    }
}

function finishCalibration() {
    const cal = state.calibration;
    state.calibration = null;

    const { delaySamples, confidence } = estimateDelaySamples(cal.refBuf, cal.micBuf, {
        maxLagSamples: cal.maxLagSamples
    });

    self.postMessage({
        type: 'delay-estimate',
        delaySamples,
        delayMs: (delaySamples * 1000) / SAMPLE_RATE,
        confidence
    });
}

function startCalibration({ durationMs = 2000, maxLagMs = 500 } = {}) {
    if (!state.ready) {
        self.postMessage({ type: 'error', stage: 'calibrate-delay', message: 'Worker not ready' });
        return;
    }
    if (state.inputs < 2) {
        self.postMessage({ type: 'error', stage: 'calibrate-delay', message: 'Model has no reference input' });
        return;
    }

    const targetLen = Math.round((durationMs / 1000) * SAMPLE_RATE);
    const maxLagSamples = Math.min(
        Math.round((maxLagMs / 1000) * SAMPLE_RATE),
        targetLen - 1
    );

    state.calibration = {
        micBuf: new Float32Array(targetLen),
        refBuf: new Float32Array(targetLen),
        writePos: 0,
        targetLen,
        maxLagSamples
    };
}

function copyEnhancedRealHalfForDebug(enhancedModelFrame, padSize, nFft, out) {
    const bins = (nFft >> 1) + 1;
    out.set(enhancedModelFrame.subarray(padSize, padSize + bins));
    return out;
}

async function processOne(inputData) {
    const _frameT0 = state.timing ? performance.now() : 0;
    const tProcess0 = state.profiling ? nowMs() : 0;

    state.framesReceived++;

    // Capture raw (pre-compensation) hops for an in-progress delay calibration.
    if (state.calibration) {
        captureCalibrationHop(inputData);
    }

    // --------------------------------------------------------
    // Time-domain preprocessing (e.g. static delay compensation)
    // --------------------------------------------------------
    for (let i = 0; i < state.timeDomainStages.length; ++i) {
        state.timeDomainStages[i].instance.process(inputData);
    }

    // --------------------------------------------------------
    // Input STFT
    // --------------------------------------------------------
    let t0 = state.profiling ? nowMs() : 0;

    applyInputNormalization(inputData);

    for (let i = 0; i < state.inputs; ++i) {
        state.inputStreams[i].processFrame(inputData[i], state.inputSpectra[i]);
    }
    if (state.profiling) {
        state.tInputStft += (nowMs() - t0);
    }

    if (state.specPort) {
        copyMagnitudeForDisplay(
            state.inputSpectra[0],
            state.pad_size,
            state.n_fft,
            state.specView
        );
        state.specPort.postMessage(state.specView);
    }

    if (state.specReferencePort && state.inputs > 1) {
        copyMagnitudeForDisplay(
            state.inputSpectra[1],
            state.pad_size,
            state.n_fft,
            state.specReferenceView
        );
        state.specReferencePort.postMessage(state.specReferenceView);
    }

    // --------------------------------------------------------
    // Build model inputs only if masking/enhancement is enabled
    // Otherwise bypass raw mic frame and disable preprocessing path
    // --------------------------------------------------------
    let modelInputs = null;
    let fallbackSpectrum = state.inputSpectra[0];

    // --------------------------------------------------------
    // Build model inputs / preprocessing
    // --------------------------------------------------------
    if (state.masking) {
        t0 = state.profiling ? nowMs() : 0;
        modelInputs = buildModelInputs();
        fallbackSpectrum = modelInputs[0];
        if (state.profiling) {
            state.tBuildModelInputs += (nowMs() - t0);
        }

        if (
            state.spectralStages.length > 0 &&
            state.specPreprocessedPort &&
            state.preprocessedOutputIndex >= 0 &&
            state.preprocessedOutputIndex < state.modelInputSpectra.length
        ) {
            copyMagnitudeForDisplay(
                state.modelInputSpectra[state.preprocessedOutputIndex],
                state.pad_size,
                state.n_fft,
                state.specPreprocessedView
            );
            state.specPreprocessedPort.postMessage(state.specPreprocessedView);
        }

        // ----------------------------------------------------
        // Chunk enqueue
        // ----------------------------------------------------
        t0 = state.profiling ? nowMs() : 0;
        enqueueModelInputFrames(modelInputs, fallbackSpectrum);
        if (state.profiling) {
            state.tChunkEnqueue += (nowMs() - t0);
        }

        // ----------------------------------------------------
        // Chunked model inference
        // ----------------------------------------------------
        if (state.session && isModelChunkReady()) {
            t0 = state.profiling ? nowMs() : 0;
            const packedChunkInputs = buildPackedModelChunk();
            if (state.profiling) {
                state.tChunkPack += (nowMs() - t0);
            }

            const modelOutputChunk = await runModel(packedChunkInputs);

            t0 = state.profiling ? nowMs() : 0;
            if (state.outputMode === 'direct') {
                if (modelOutputChunk) {
                    enqueueDirectOutputChunk(modelOutputChunk);
                } else if (!state.bypassOnModelError) {
                    throw new Error('Model returned invalid direct spectrum chunk');
                }
            } else if (state.outputMode === 'mask') {
                if (modelOutputChunk) {
                    enqueueMaskOutputChunk(modelOutputChunk);
                } else if (!state.bypassOnModelError) {
                    throw new Error('Model returned invalid mask chunk');
                }
            } else {
                throw new Error(`Unsupported output mode: ${state.outputMode}`);
            }

            consumeInputChunkFrames();

            if (state.profiling) {
                state.tChunkOutput += (nowMs() - t0);
            }
        }
    } else {
        // enhancement disabled: no preprocessing, direct bypass
        if (state.preprocessedSpectrum) {
            state.preprocessedSpectrum.set(state.inputSpectra[0]);
        }
        state.enhancedSpectrum.set(state.inputSpectra[0]);
    }

    if (state.specProcessedPort) {
        copyMagnitudeForDisplay(
            state.enhancedSpectrum,
            state.pad_size,
            state.n_fft,
            state.specProcessedView
        );
        state.specProcessedPort.postMessage(state.specProcessedView);
    }

    // --------------------------------------------------------
    // Select one output frame for this callback
    // --------------------------------------------------------
    let selectedSpectrum = state.inputSpectra[0];

    if (state.masking) {
        const enhancedFrame = dequeueEnhancedFrameOrFallback(fallbackSpectrum);
        state.enhancedSpectrum.set(enhancedFrame);

        if (state.outputSelection === 'preprocessed') {
            selectedSpectrum = state.preprocessedSpectrum || state.inputSpectra[0];
        } else if (state.outputSelection === 'full') {
            selectedSpectrum = state.enhancedSpectrum;
        }
    }

    // --------------------------------------------------------
    // Synthesis
    // --------------------------------------------------------
    t0 = state.profiling ? nowMs() : 0;
    state.outputStream.processSpectrum(selectedSpectrum, state.outputBlock);
    denormalizeOutputBlock(state.outputBlock);
    if (state.profiling) {
        state.tSynthesis += (nowMs() - t0);
    }

    state.framesProcessed++;
    if (state.timing) recordFrameTime(performance.now() - _frameT0);

    if (state.profiling) {
        state.tProcessFrameTotal += (nowMs() - tProcess0);
        state.profileFramesAccumulated += 1;
    }

    maybePostPeriodicStatus();
    maybePostProfilingStatus();

    return cloneFloat32(state.outputBlock);
}

// ------------------------------------------------------------
// Backlog handling
// ------------------------------------------------------------

async function workerLoop() {
    if (state.busy || !state.ready) return;
    state.busy = true;

    try {
        while (true) {
            let current = null;

            if (state.backlogPolicy === 'drop-old') {
                if (state.pendingMlFrame) {
                    current = state.pendingMlFrame;
                    state.pendingMlFrame = null;
                } else {
                    break;
                }
            } else {
                if (state.queue.length > 0) {
                    current = state.queue.shift();
                } else {
                    break;
                }
            }

            const out = await processOne(current);

            if (state.mlPort) {
                state.mlPort.postMessage(out);
            }
        }
    } catch (err) {
        console.error('Inference pipeline failed:', err);
        postStatus({
            type: 'error',
            source: 'ml-worker',
            stage: 'pipeline',
            message: String(err)
        });
    } finally {
        state.busy = false;

        if (
            (state.backlogPolicy === 'drop-old' && state.pendingMlFrame) ||
            (state.backlogPolicy === 'queue' && state.queue.length > 0)
        ) {
            workerLoop();
        }
    }
}

function onMlFrame(inputData) {
    if (!state.ready) return;

    const inputCopy = cloneInputFrameArray(
        inputData,
        state.inputs,
        state.hop_length
    );

    if (state.backlogPolicy === 'drop-old') {
        if (state.pendingMlFrame) {
            state.framesDropped++;
        }
        state.pendingMlFrame = inputCopy;
    } else {
        state.queue.push(inputCopy);
    }

    workerLoop();
}

// ------------------------------------------------------------
// Teardown
// ------------------------------------------------------------

// Drops the ONNX session and every large buffer. The caller terminates the
// worker straight after: releasing the session returns its memory to the wasm
// heap, but a WebAssembly.Memory never shrinks, so only destroying the worker
// actually hands it back to the OS. This exists so that a stop still frees
// things if the worker is kept alive for some reason, and so the model is not
// left resident on a phone after a demo.
async function disposeWorker() {
    state.ready = false;
    state.initializing = false;

    state.pendingMlFrame = null;
    state.queue.length = 0;

    if (state.session) {
        try {
            if (typeof state.session.release === 'function') {
                await state.session.release();
            }
        } catch (err) {
            console.warn('ONNX session release failed:', err);
        }
        state.session = null;
    }

    state.feeds = null;
    state.inputTensors = null;
    state.stateInputs = [];
    state.modelInputFrameRing = [];
    state.maskBaseFrameRing = [];
    state.modelOutputFrameQueue = [];
    state.packedModelInputs = [];
    state.modelInputSpectra = [];
    state.inputStreams = [];
    state.inputSpectra = [];
    state.outputStream = null;
    state.stftTools = null;
    state.preprocessingStages = [];
    state.timeDomainStages = [];
    state.spectralStages = [];
    state.calibration = null;
    state.inputNorm = null;

    for (const port of [state.mlPort, state.specPort, state.specProcessedPort,
                        state.specReferencePort, state.specPreprocessedPort]) {
        if (!port) continue;
        try { port.onmessage = null; } catch (_) {}
        try { port.close(); } catch (_) {}
    }
    state.mlPort = null;
    state.specPort = null;
    state.specProcessedPort = null;
    state.specReferencePort = null;
    state.specPreprocessedPort = null;

    if (state.statusPort) {
        try { state.statusPort.close(); } catch (_) {}
        state.statusPort = null;
    }

    // Direct, not via the status port: by the time a stop reaches us the main
    // thread has already closed its side of that channel. This ack is what lets
    // the caller terminate us without cutting the release short.
    self.postMessage({ type: 'disposed', source: 'ml-worker' });
}

// ------------------------------------------------------------
// Messaging
// ------------------------------------------------------------

function attachMlPort(port) {
    state.mlPort = port;
    state.mlPort.onmessage = (e) => {
        onMlFrame(e.data);
    };
}

self.addEventListener('message', (event) => {
    const data = event.data;

    switch (data.type) {
        case 'init':
            initializeWorker(data.name, data.config);
            break;

        case 'attach-ml-port':
            attachMlPort(data.port);
            break;

        case 'attach-spec-port':
            state.specPort = data.port;
            break;

        case 'attach-spec-processed-port':
            state.specProcessedPort = data.port;
            break;

        case 'attach-spec-reference-port':
            state.specReferencePort = data.port;
            break;

        case 'attach-spec-preprocessed-port':
            state.specPreprocessedPort = data.port;
            break;


        case 'attach-status-port':
            state.statusPort = data.port;
            break;

        case 'mask-toggle':
            state.masking = !!data.value;
            maybePostPeriodicStatus();
            break;
        
        case 'set-output-selection':
            if (
                data.value === 'raw' ||
                data.value === 'preprocessed' ||
                data.value === 'full'
            ) {
                state.outputSelection = data.value;
            }
            maybePostPeriodicStatus();
            break;

        case 'set-backlog-policy':
            if (data.value === 'drop-old' || data.value === 'queue') {
                state.backlogPolicy = data.value;
            }
            maybePostPeriodicStatus();
            break;

        case 'reset':
            resetStreamingState();
            break;

        case 'set-delay-samples': {
            const stage = state.preprocessingStages.find(
                (s) => s.instance && PREPROCESSOR_DOMAIN[s.type] === 'time'
            );
            if (stage) stage.instance.setDelaySamples(data.delaySamples | 0);
            break;
        }

        case 'calibrate-delay':
            startCalibration(data);
            break;

        case 'dispose':
            disposeWorker();
            break;
    }
});

self.addEventListener('messageerror', (e) => {
    console.error('ML worker messageerror:', e);
});
