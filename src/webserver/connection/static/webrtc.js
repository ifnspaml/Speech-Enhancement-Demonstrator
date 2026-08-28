const roomName = document.body.dataset.roomName;

// Mutable: a room may offer several models and switch between them at runtime.
let modelName = document.body.dataset.modelName;

function parseAvailableModels() {
  const raw = document.body.dataset.availableModels;
  if (!raw) return modelName ? [modelName] : [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length ? list : [modelName];
  } catch (_) {
    return modelName ? [modelName] : [];
  }
}

const availableModels = parseAvailableModels();

const startButton = document.getElementById('startButton');
const hangupButton = document.getElementById('hangupButton');
const muteButton = document.getElementById('muteButton');
const demoSpeechButton = document.getElementById('demoSpeechButton');
const maskingCheckbox = document.getElementById('masking');
const maskingGroup = document.getElementById('maskingGroup') ||
  maskingCheckbox?.closest('.control-group');
const transmissionModeSelect = document.getElementById('transmissionMode');
const transmissionModeGroup = document.getElementById('transmissionModeGroup') ||
  transmissionModeSelect?.closest('.transmission-mode-group');
const micGainSlider = document.getElementById('micGain');
const micGainValueLabel = document.getElementById('micGainValue');
const micGainResetButton = document.getElementById('micGainReset');
const micLevelBar = document.getElementById('micLevelBar');
const modelGroup = document.getElementById('modelGroup');
const modelSelect = document.getElementById('modelSelect');
const modelSwitchState = document.getElementById('modelSwitchState');
const modelSyncPeersCheckbox = document.getElementById('modelSyncPeers');
const remoteGroup = document.getElementById('remoteGroup');
const remoteMuteCheckbox = document.getElementById('remoteMute');
const remoteMaskingCheckbox = document.getElementById('remoteMasking');
const remoteStatusEl = document.getElementById('remoteStatus');
const remoteNoticeEl = document.getElementById('remoteNotice');
const remoteControlEnableCheckbox = document.getElementById('remoteControlEnable');
const remoteControlAcceptCheckbox = document.getElementById('remoteControlAccept');
const labelSetSelect = document.getElementById('labelSetSelect');
const captureDeviceSelect = document.getElementById('captureDevice');
const captureToggleEls = {
  autoGainControl: document.getElementById('capAgc'),
  echoCancellation: document.getElementById('capAec'),
  noiseSuppression: document.getElementById('capNs')
};
const leftSignalSelect = document.getElementById('leftSignalSelect');
const rightSignalSelect = document.getElementById('rightSignalSelect');
const panelControlEls = [
  document.getElementById('leftPanelControls'),
  document.getElementById('rightPanelControls')
];
const heroTitleEl = document.getElementById('heroTitle');
const localGroupLabel = document.getElementById('localGroupLabel');
const remoteTitleText = document.getElementById('remoteTitleText');
const modelGroupLabelText = document.getElementById('modelGroupLabelText');
const micGainLabelText = document.getElementById('micGainLabelText');

// The room's own heading, kept so a wording suffix can be re-applied without
// stacking up on every model switch.
const heroTitleBase = heroTitleEl ? heroTitleEl.textContent.trim() : '';
const measureDelayButton = document.getElementById('measureDelayButton');
const delayReadoutEl = document.getElementById('delay-readout');

// Keep the on-page <canvas> elements: after transferControlToOffscreen the main
// thread can no longer draw to them, but it can still measure their CSS layout
// size (getBoundingClientRect) to size the worker's backing store responsively.
const specCanvasEl = document.getElementById('spectrogram');
const specCanvasProcessedEl = document.getElementById('spectrogram-processed');

// Spectrogram rendering is offloaded to workers via OffscreenCanvas. 
// This runs at module scope, so on an older browser
// an uncaught throw here would kill the whole script. Degrade to
// "no spectrograms, audio still works" instead.
let specCanvas = null;
let specCanvasProcessed = null;
let spectrogramsSupported = false;

if (typeof specCanvasEl.transferControlToOffscreen === 'function') {
  try {
    specCanvas = specCanvasEl.transferControlToOffscreen();
    specCanvasProcessed = specCanvasProcessedEl.transferControlToOffscreen();
    spectrogramsSupported = true;
  } catch (err) {
    console.warn('OffscreenCanvas unavailable, spectrograms disabled:', err);
    specCanvas = null;
    specCanvasProcessed = null;
    spectrogramsSupported = false;
  }
} else {
  console.warn(
    'This browser has no OffscreenCanvas support; spectrogram display is ' +
    'disabled. Audio processing is unaffected.'
  );
}

const offerOptions = {
  offerToReceiveAudio: 1,
  offerToReceiveVideo: 0,
  voiceActivityDetection: false
};

const DEFAULT_DEMO_AUDIO = {
  enabled: true,
  name: 'Prepared speech sample',
  url: '/static/assets/audio/farend_speech.wav',
  loop: true
};

// ------------------------------------------------------------
// Signal labelling
// ------------------------------------------------------------
// 'technical' is the engineering vocabulary and stays the default. 'demo' is
// for the case where the page is shown on one screen while the processing runs
// on another device
const SIGNAL_LABEL_SETS = {
  technical: {
    mic: {
      option: 'Microphone',
      title: 'Microphone',
      explanation: 'Shows the selected live signal spectrum.'
    },
    enhanced: {
      option: 'Enhanced',
      title: 'Enhanced Output',
      explanation: 'Shows the selected live signal spectrum.'
    },
    reference: {
      option: 'Reference / Loudspeaker',
      title: 'Reference / Loudspeaker',
      explanation: 'Shows the selected live signal spectrum.'
    },
    preprocessed: {
      option: 'Preprocessed',
      title: 'Preprocessed Signal',
      explanation: 'Shows the selected live signal spectrum.'
    }
  },

  demo: {
    // This screen only visualises what the other device is doing, so it runs no
    // enhancement of its own and is the handset-free place to drive the room from.
    behavior: {
      processing: false,
      remoteControl: true,
      syncModel: true,
      // The two signals that exist on the other side: what its loudspeaker
      // plays, and what it sends back after enhancing.
      signals: { left: 'enhanced', right: 'reference' },
      lockSignals: true,
      remoteText: 'Processing on the other device',

      // Which side of the link each control acts on is the thing an audience
      // (and a presenter mid-demo) keeps having to ask about.
      titleSuffix: 'Far-End',
      localGroupLabel: 'Audio Transmission Controls (FE)',
      remoteGroupLabel: 'Other participants (NE)',
      modelLabel: 'Model (NE)',
      micGainLabel: 'FE microphone gain'
    },

    mic: {
      option: 'Input',
      title: 'Far-End Microphone',
      explanation: 'Shows the selected live signal spectrum.'
    },
    enhanced: {
      option: 'Output',
      title: 'Transmitted Far-end Audio',
      explanation: 'Shows the selected live signal spectrum.'
    },
    reference: {
      option: 'Incoming',
      title: 'Enhanced Near-End Audio',
      explanation: 'Shows the selected live signal spectrum.'
    },
    preprocessed: {
      option: 'Preprocessed',
      title: 'Preprocessed Signal',
      explanation: 'Shows the selected live signal spectrum.'
    }
  }
};

const LABEL_SET_NAMES = Object.keys(SIGNAL_LABEL_SETS);
const DEFAULT_LABEL_SET = 'technical';

// What a label set implies beyond wording. A set that declares nothing behaves
// exactly as the demonstrator always did.
const DEFAULT_LABEL_BEHAVIOR = {
  processing: true,
  remoteControl: false,
  syncModel: false,
  signals: null,
  lockSignals: false,
  idleText: 'Processing inactive',
  activeText: 'Enhancement active',
  bypassText: 'Bypass mode',
  remoteText: 'Processing on the other device',
  titleSuffix: '',
  localGroupLabel: 'This device',
  remoteGroupLabel: 'Other participants',
  modelLabel: 'Model',
  micGainLabel: 'Microphone gain'
};
const LABEL_SET_STORAGE_KEY = 'spen.labelSet';
const SIGNAL_KEYS = ['mic', 'enhanced', 'reference', 'preprocessed'];

const app = {
  id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),

  config: null,

  signaling: null,
  reconnectTimer: null,

  ac: null,
  mic: null,
  micStream: null,
  micGain: null,
  micGainDb: 0,
  micAnalyser: null,
  micLevelBuf: null,
  micLevelTimer: null,
  micLevelDb: -Infinity,
  wakeLock: null,

  // Browser-side capture settings, remembered per microphone.
  capture: {
    deviceId: '',
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false
  },
  captureCapabilities: null,
  captureSwitching: false,
  modelSwitching: false,

  // What the user chose to display, kept across model changes that cannot
  // offer it temporarily.
  preferredSignals: { left: 'mic', right: 'enhanced' },

  // Active signal wording; per viewing device, see resolveLabelSet().
  labelSet: DEFAULT_LABEL_SET,

  // Last state each peer reported, keyed by their client id.
  peerStates: new Map(),
  remoteNoticeTimer: null,
  merger: null,
  preOutput: null,
  localStream: null,
  mlWorkletNode: null,

  // Static per-device delay compensation (reference vs. mic), measured via a
  // one-shot calibration and persisted per capture device.
  delayCalibrating: false,
  delayCalibrationNode: null,

  // optional audio from file
  transmitSource: 'mic', // 'mic' | 'file'

  txFileBuffer: null,
  txFileNode: null,
  txFileGain: null,
  txFileLoading: false,
  demoSpeechAvailable: false,
  txFileUrl: null,

  mlWorker: null,
  specWorkerNoisy: null,
  specWorkerProcessed: null,

  mlChannel: null,
  specChannel: null,
  specChannelProcessed: null,
  specChannelReference: null,
  specChannelPreprocessed: null,
  statusChannel: null,

  specPortMic: null,
  specPortEnhanced: null,
  specPortReference: null,
  specPortPreprocessed: null,

  started: false,
  muted: false,
  canvasAttached: false,
  availableSignals: {
    mic: true,
    enhanced: true,
    reference: true,
    preprocessed: false
  },
  transmissionOptions: {
    rawLabel: 'Unprocessed microphone',
    preprocessedLabel: 'Preprocessed',
    fullLabel: 'Fully processed'
  },

  workerReady: false,
  workletReady: false,

  peerConnections: new Map(),
  remoteAudioElements: new Map(),

  lastWorkerStats: null,
  lastWorkletStats: null
};

hangupButton.disabled = true;

// ------------------------------------------------------------
// Debug / UI helpers
// ------------------------------------------------------------

function getDemoAudioConfig() {
  return {
    ...DEFAULT_DEMO_AUDIO,
    ...(app.config?.demo_audio || {})
  };
}

function hasDemoSpeech() {
  const cfg = getDemoAudioConfig();
  return !!(cfg && cfg.enabled && cfg.url);
}

function updateDemoSpeechButton() {
  if (!demoSpeechButton) return;

  const shouldShow = app.muted && hasDemoSpeech();
  demoSpeechButton.classList.toggle('d-none', !shouldShow);

  if (app.transmitSource === 'file') {
    demoSpeechButton.textContent = 'Disable demo';
  } else {
    demoSpeechButton.textContent = 'Demo signal';
  }
}

function getProcessingUiConfig() {
  return app.config?.processing_ui || {};
}

// Preprocessing config may be a single legacy object
function getPreprocessingStages() {
  const raw = app.config?.preprocessing;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

const SPECTRAL_PREPROCESSOR_TYPES = new Set(['diffusion_noise']);

function hasSpectralPreprocessingEnabled() {
  return getPreprocessingStages().some((s) => s.enabled && SPECTRAL_PREPROCESSOR_TYPES.has(s.type));
}

function isSignificantPreprocessingEnabled() {
  return getPreprocessingStages().some((s) => s.enabled && s.significant);
}

function getSignificantPreprocessingNames() {
  return getPreprocessingStages()
    .filter((s) => s.enabled && s.significant)
    .map((s) => s.name || s.type)
    .filter(Boolean);
}

function buildTransmissionLabels() {
  const ui = getProcessingUiConfig();
  const significantPre = isSignificantPreprocessingEnabled();
  const preNames = getSignificantPreprocessingNames();

  const rawLabel = ui.raw_name || 'Unprocessed microphone';

  let preprocessedLabel = 'Preprocessed';
  if (significantPre && preNames.length > 0) {
    preprocessedLabel = `Preprocessed: ${preNames.join(' + ')}`;
  }

  let fullLabel = ui.full_name || 'Fully processed';
  if (!ui.full_name) {
    if (significantPre && preNames.length > 0) {
      fullLabel = `Fully processed: ${preNames.join(' + ')} + ${modelName}`;
    } else {
      fullLabel = `Fully processed: ${modelName}`;
    }
  }

  app.transmissionOptions = {
    rawLabel,
    preprocessedLabel,
    fullLabel
  };
}

function updateTransmissionModeOptionsFromConfig() {
  buildTransmissionLabels();

  const significantPre = isSignificantPreprocessingEnabled();

  const rawOpt = transmissionModeSelect.querySelector('option[value="raw"]');
  const preOpt = transmissionModeSelect.querySelector('option[value="preprocessed"]');
  const fullOpt = transmissionModeSelect.querySelector('option[value="full"]');

  if (rawOpt) rawOpt.textContent = app.transmissionOptions.rawLabel;

  if (preOpt) {
    preOpt.textContent = app.transmissionOptions.preprocessedLabel;
    preOpt.disabled = !significantPre;
  }

  if (fullOpt) fullOpt.textContent = app.transmissionOptions.fullLabel;

  if (!significantPre && transmissionModeSelect.value === 'preprocessed') {
    transmissionModeSelect.value = 'raw';
  }

  setText('dbg-transmission-mode', transmissionModeSelect.options[transmissionModeSelect.selectedIndex]?.text || '—');
}

function updateTransmissionModeEnabledState() {
  const enabled = !!(app.started && maskingCheckbox.checked);
  transmissionModeSelect.disabled = !enabled;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = String(value);
  }
}

function setStatusValue(id, label, level = 'ok') {
  const el = document.getElementById(id);
  if (!el) return;

  const dotClass =
    level === 'ok'
      ? 'status-dot status-ok'
      : level === 'warn'
        ? 'status-dot status-warn'
        : 'status-dot status-bad';

  el.innerHTML = `<span class="${dotClass}"></span>${label}`;
}

function updateProcessingChip() {
  const dot = document.getElementById('processing-chip-dot');
  const text = document.getElementById('processing-chip-text');
  if (!dot || !text) return;

  const b = getLabelSetBehavior();

  // A device that is not meant to process is doing its job whenever it runs;
  // "Bypass" would read as a fault to an audience watching this screen.
  const active = app.started && (!b.processing || maskingCheckbox.checked);

  dot.classList.remove('on', 'off');
  dot.classList.add(active ? 'on' : 'off');

  if (!app.started) {
    text.textContent = b.idleText;
  } else if (!b.processing) {
    text.textContent = b.remoteText;
  } else if (maskingCheckbox.checked) {
    text.textContent = b.activeText;
  } else {
    text.textContent = b.bypassText;
  }
}

function updateStaticDebugInfo() {
  setText('dbg-model', modelName);
  setText('dbg-room', roomName);

  if (app.config) {
    setText('dbg-hop', app.config.hop_size);
    setText('dbg-nfft', app.config.n_fft);
    setText('dbg-inputs', app.config.inputs);
    setText(
      'dbg-preprocessing',
      getPreprocessingStages().some((s) => s.enabled) ? 'Enabled' : 'Disabled'
    );

    const la = Number(app.config.lookahead || 0);
    const chunk = Number.isInteger(app.config.chunk_size)
      ? app.config.chunk_size
      : (app.config.input_shape?.[3] ?? 1) - la;
    const delayMs = (la * app.config.hop_size / 16000) * 1000;
    setText('dbg-chunk', la > 0
      ? `${chunk} + ${la} (${delayMs.toFixed(0)} ms delay)`
      : `${chunk}`);
  } else {
    setText('dbg-hop', '—');
    setText('dbg-nfft', '—');
    setText('dbg-inputs', '—');
    setText('dbg-preprocessing', '—');
    setText('dbg-chunk', '—');
  }

  setText('dbg-samplerate', app.ac ? app.ac.sampleRate : 16000);
}

function updateUiStateDebug() {
  let wsLabel = 'Disconnected';
  let wsLevel = 'bad';

  if (app.signaling) {
    if (app.signaling.readyState === WebSocket.OPEN) {
      wsLabel = 'Connected';
      wsLevel = 'ok';
    } else if (app.signaling.readyState === WebSocket.CONNECTING) {
      wsLabel = 'Connecting';
      wsLevel = 'warn';
    }
  }

  setStatusValue('dbg-websocket', wsLabel, wsLevel);
  setStatusValue('dbg-worker', app.workerReady ? 'Ready' : 'Not ready', app.workerReady ? 'ok' : 'warn');
  setStatusValue('dbg-worklet', app.workletReady ? 'Attached' : 'Not ready', app.workletReady ? 'ok' : 'warn');

  setText('dbg-masking', maskingCheckbox.checked ? 'Enabled' : 'Disabled');
  setText('dbg-muted', app.muted ? 'Yes' : 'No');
  setText('dbg-peers', app.peerConnections.size);
  setText('dbg-samplerate', app.ac ? app.ac.sampleRate : 16000);
  setText(
    'dbg-transmission-mode',
    transmissionModeSelect.options[transmissionModeSelect.selectedIndex]?.text || '—'
  );

  updateDemoSpeechButton();
  updateTransmissionModeEnabledState();
  updateProcessingChip();
}

function getSelectedSignal(side) {
  return side === 'left' ? leftSignalSelect.value : rightSignalSelect.value;
}

// Precedence, most specific first:
//   1. ?labels=demo   -- bookmark the display device straight into demo wording
//   2. the debug-panel choice, remembered on this device
//   3. DEFAULT_LABEL_SET
// Deliberately not taken from the room or model config: both devices share
// those, and only one of them is the screen the audience is reading.
function resolveLabelSet() {
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get('labels');
  } catch (_) {}
  if (fromUrl && SIGNAL_LABEL_SETS[fromUrl]) return fromUrl;

  try {
    const stored = window.localStorage.getItem(LABEL_SET_STORAGE_KEY);
    if (stored && SIGNAL_LABEL_SETS[stored]) return stored;
  } catch (_) {}

  return DEFAULT_LABEL_SET;
}

// Only the keys present are replaced, so a config can retitle one signal and
// leave the rest alone.
function getSignalLabels(signalKey) {
  const base = SIGNAL_LABEL_SETS[app.labelSet] || SIGNAL_LABEL_SETS[DEFAULT_LABEL_SET];
  const fallback = SIGNAL_LABEL_SETS[DEFAULT_LABEL_SET][signalKey] || {};
  const set = base[signalKey] || fallback;

  const override = app.config?.signal_labels?.[app.labelSet]?.[signalKey] || {};

  return {
    option: override.option ?? set.option ?? signalKey,
    title: override.title ?? set.title ?? signalKey,
    explanation: override.explanation ??
      set.explanation ?? 'Shows the selected live signal spectrum.'
  };
}

// Layered like getSignalLabels(), so a room config can retune a set without a
// code change.
function getLabelSetBehavior() {
  return {
    ...DEFAULT_LABEL_BEHAVIOR,
    ...(SIGNAL_LABEL_SETS[app.labelSet]?.behavior || {}),
    ...(app.config?.signal_labels?.[app.labelSet]?.behavior || {})
  };
}

function localProcessingEnabled() {
  return getLabelSetBehavior().processing;
}

function setPanelMeta(side, signalKey) {
  const meta = getSignalLabels(signalKey);

  setText(`${side}-panel-title`, meta.title);
  setText(`${side}-panel-explanation`, meta.explanation);
}

// The dropdown entries name the signals too, so they follow the same set.
function applySignalOptionLabels() {
  for (const selectEl of [leftSignalSelect, rightSignalSelect]) {
    if (!selectEl) continue;
    for (const key of SIGNAL_KEYS) {
      const opt = selectEl.querySelector(`option[value="${key}"]`);
      if (opt) opt.textContent = getSignalLabels(key).option;
    }
  }
}

function refreshPanelLabels() {
  applySignalOptionLabels();
  setPanelMeta('left', getSelectedSignal('left'));
  setPanelMeta('right', getSelectedSignal('right'));
}

function setLabelSet(name, { persist = true } = {}) {
  app.labelSet = SIGNAL_LABEL_SETS[name] ? name : DEFAULT_LABEL_SET;

  if (persist) {
    try {
      window.localStorage.setItem(LABEL_SET_STORAGE_KEY, app.labelSet);
    } catch (_) {}
  }

  if (labelSetSelect) labelSetSelect.value = app.labelSet;
  refreshPanelLabels();
  applyLabelSetBehavior({ entering: true });
}

// The wording a device shows also declares its role. Enabling effects are
// one-directional: switching back to a processing set reveals the enhancement
// toggle again but never undoes what the presenter switched on meanwhile.
function applyLabelSetBehavior({ entering = false } = {}) {
  const b = getLabelSetBehavior();

  // Transmission mode only means anything while this device processes.
  if (maskingGroup) maskingGroup.classList.toggle('d-none', !b.processing);
  if (transmissionModeGroup) {
    transmissionModeGroup.classList.toggle('d-none', !b.processing);
  }

  if (!b.processing && maskingCheckbox.checked) {
    setMaskingEnabled(false);
    broadcastControlState();
  }

  // Only when the wording is chosen: a later model switch must not undo a
  // panel the presenter picked by hand.
  if (entering && b.signals) {
    if (b.signals.left) app.preferredSignals.left = b.signals.left;
    if (b.signals.right) app.preferredSignals.right = b.signals.right;

    enforceValidSelection(leftSignalSelect, 'mic', app.preferredSignals.left);
    enforceValidSelection(rightSignalSelect, 'enhanced', app.preferredSignals.right);
    rerenderPanelsOnSelectionChange();
  }

  // Fixed panels have nothing to choose, so the selectors only add noise.
  for (const el of panelControlEls) {
    if (el) el.classList.toggle('d-none', !!b.lockSignals);
  }

  if (heroTitleEl) {
    heroTitleEl.textContent = b.titleSuffix
      ? `${heroTitleBase} — ${b.titleSuffix}`
      : heroTitleBase;
  }

  if (localGroupLabel) localGroupLabel.textContent = b.localGroupLabel;
  if (remoteTitleText) remoteTitleText.textContent = b.remoteGroupLabel;
  if (modelGroupLabelText) modelGroupLabelText.textContent = b.modelLabel;
  if (micGainLabelText) micGainLabelText.textContent = b.micGainLabel;

  if (b.remoteControl && remoteControlEnableCheckbox &&
      !remoteControlEnableCheckbox.checked) {
    remoteControlEnableCheckbox.checked = true;
    refreshRemoteUi();
    // Dropped while the socket is still connecting; onopen re-issues it.
    sendSignalingMessage({ type: 'control-query', id: app.id });
  }

  if (b.syncModel && modelSyncPeersCheckbox && !modelSyncPeersCheckbox.checked) {
    modelSyncPeersCheckbox.checked = true;
  }

  setText('dbg-label-set', b.processing
    ? app.labelSet
    : `${app.labelSet} (no local processing)`);
  updateProcessingChip();
}

function setupLabelSetControls() {
  if (labelSetSelect) {
    labelSetSelect.innerHTML = '';
    for (const name of LABEL_SET_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      labelSetSelect.appendChild(opt);
    }
    labelSetSelect.addEventListener('change', (e) => setLabelSet(e.target.value));
  }

  // A ?labels= parameter is a deliberate choice for this screen; remember it so
  // a reload without the parameter keeps the same wording.
  setLabelSet(resolveLabelSet());
}

function setSignalOptionEnabled(selectEl, value, enabled) {
  const opt = selectEl.querySelector(`option[value="${value}"]`);
  if (!opt) return;
  opt.disabled = !enabled;
}

// Remembers what the user actually asked to see, so a model that cannot offer
// it (a single-input model has no reference signal) forces a fallback without
// losing the preference -- switching back to a capable model restores it.
function enforceValidSelection(selectEl, fallbackValue, preferred) {
  const optionUsable = (value) => {
    if (!value) return false;
    const opt = selectEl.querySelector(`option[value="${value}"]`);
    return !!opt && !opt.disabled;
  };

  if (preferred && preferred !== selectEl.value && optionUsable(preferred)) {
    selectEl.value = preferred;
    return;
  }

  if (!optionUsable(selectEl.value)) {
    selectEl.value = fallbackValue;
  }
}

function updateSignalAvailabilityFromConfig() {
  const hasReference = !!(app.config && app.config.inputs >= 2);
  const hasPreprocessed = hasSpectralPreprocessingEnabled();

  app.availableSignals.mic = true;
  app.availableSignals.enhanced = true;
  app.availableSignals.reference = hasReference;
  app.availableSignals.preprocessed = hasPreprocessed;

  for (const selectEl of [leftSignalSelect, rightSignalSelect]) {
    setSignalOptionEnabled(selectEl, 'mic', true);
    setSignalOptionEnabled(selectEl, 'enhanced', true);
    setSignalOptionEnabled(selectEl, 'reference', hasReference);
    setSignalOptionEnabled(selectEl, 'preprocessed', hasPreprocessed);
  }

  enforceValidSelection(leftSignalSelect, 'mic', app.preferredSignals.left);
  enforceValidSelection(rightSignalSelect, 'enhanced', app.preferredSignals.right);

  setText('dbg-preprocessing', hasPreprocessed ? 'Enabled' : 'Disabled');

  refreshPanelLabels();
}

// Visible time span the panels aim for, and the ceiling on how wide a single
// frame may be drawn (a very small hop must not turn into a smeared block).
const SPECTROGRAM_SPAN_S = 4;
const MAX_COLUMNS_PER_FRAME = 8;

// Size a spectrogram worker's backing store to the element's displayed size ×
// devicePixelRatio (crisp, not upscaled), and update its time-axis label to the
// real visible span: span = (backingWidth / columnsPerFrame) * hop / sampleRate.
function syncSpectrogramCanvas(worker, el) {
  if (!worker || !el) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = el.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));

  // Cap the backing store so the worker's per-tick full redraw (O(W*H), ~33 fps,
  // two workers) stays cheap on modest hardware. Below the caps we render at the
  // device pixel ratio for crispness; above them the canvas is downscaled to fit.
  const MAX_BACKING_W = 1280;
  const MAX_BACKING_H = 384;
  const backingW = Math.max(1, Math.min(MAX_BACKING_W, Math.round(cssW * dpr)));
  const backingH = Math.max(1, Math.min(MAX_BACKING_H, Math.round(cssH * dpr)));

  const hopSize = (app.config && app.config.hop_size) || 128;
  const sampleRate = (app.ac && app.ac.sampleRate) || 16000;

  // One frame per pixel column packs ~10 s into a panel, where a syllable is a
  // few pixels wide and speech reads as thin streaks. Widen each frame so the
  // visible span stays near SPECTROGRAM_SPAN_S regardless of hop size.
  const framesPerSpan = (SPECTROGRAM_SPAN_S * sampleRate) / hopSize;
  const columnsPerFrame = Math.max(1, Math.min(
    MAX_COLUMNS_PER_FRAME,
    Math.round(backingW / framesPerSpan)
  ));

  worker.postMessage({
    type: 'resize',
    width: backingW,
    height: backingH,
    columnsPerFrame
  });

  if (app.config) {
    const seconds = ((backingW / columnsPerFrame) * hopSize) / sampleRate;
    const axisId = el.id === 'spectrogram' ? 'x-axis-spectrogram' : 'x-axis-processed';
    setText(axisId, `${seconds.toFixed(2)} s`);
  }
}

function updateXAxisLabels() {
  syncSpectrogramCanvas(app.specWorkerNoisy, specCanvasEl);
  syncSpectrogramCanvas(app.specWorkerProcessed, specCanvasProcessedEl);
}

function setupSpectrogramResize() {
  updateXAxisLabels();

  if (app._specResizeObserver || typeof ResizeObserver === 'undefined') {
    // Fall back to window resize only if ResizeObserver is unavailable.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateXAxisLabels);
    }
    return;
  }

  const ro = new ResizeObserver(() => updateXAxisLabels());
  ro.observe(specCanvasEl);
  ro.observe(specCanvasProcessedEl);
  app._specResizeObserver = ro;

  // Catches devicePixelRatio changes (e.g. moving between monitors) that a
  // ResizeObserver on the element does not report.
  window.addEventListener('resize', updateXAxisLabels);
}

function panelWantsSignal(side, signalKey) {
  return getSelectedSignal(side) === signalKey;
}

function postSpectrumToPanel(side, data) {
  const worker = side === 'left' ? app.specWorkerNoisy : app.specWorkerProcessed;
  if (!worker) return;

  worker.postMessage({
    type: 'frame',
    data
  });
}

function clearPanel(side) {
  const worker = side === 'left' ? app.specWorkerNoisy : app.specWorkerProcessed;
  if (!worker) return;

  worker.postMessage({ type: 'clear' });
}

function rerenderPanelsOnSelectionChange() {
  refreshPanelLabels();
  clearPanel('left');
  clearPanel('right');
}

function cloneSpectrumFrame(data) {
  if (data instanceof Float32Array) {
    return new Float32Array(data);
  }
  return data;
}

function handleIncomingSpectrum(signalKey, payload) {
  // Without OffscreenCanvas
  if (!spectrogramsSupported) return;

  const sendLeft = panelWantsSignal('left', signalKey);
  const sendRight = panelWantsSignal('right', signalKey);

  if (!sendLeft && !sendRight) return;

  if (sendLeft && sendRight) {
    const frameA = cloneSpectrumFrame(payload);
    const frameB = cloneSpectrumFrame(payload);
    postSpectrumToPanel('left', frameA);
    postSpectrumToPanel('right', frameB);
    return;
  }

  const frame = cloneSpectrumFrame(payload);
  if (sendLeft) {
    postSpectrumToPanel('left', frame);
  } else {
    postSpectrumToPanel('right', frame);
  }
}


function updateWorkerStatsDebug(msg) {
  app.lastWorkerStats = msg;

  const dropped = Number(msg.framesDropped || 0);
  const label = msg.ready
    ? (dropped > 0 ? 'Running (drops)' : 'Running')
    : 'Not ready';
  const level = !msg.ready ? 'warn' : (dropped > 0 ? 'warn' : 'ok');

  setStatusValue('dbg-worker', label, level);
  setText('dbg-worker-frames-in', msg.framesReceived ?? '—');
  setText('dbg-worker-frames-out', msg.framesProcessed ?? '—');
  setText('dbg-worker-dropped', dropped);

  if (typeof msg.masking === 'boolean') {
    setText('dbg-masking', msg.masking ? 'Enabled' : 'Disabled');
  }

  if (msg.outputSelection) {
    const opt = transmissionModeSelect.querySelector(`option[value="${msg.outputSelection}"]`);
    if (opt) {
      transmissionModeSelect.value = msg.outputSelection;
      setText('dbg-transmission-mode', opt.textContent);
    }
  }
}

function updateWorkletStatsDebug(msg) {
  app.lastWorkletStats = msg;

  const underruns = Number(msg.outputUnderruns || 0);

  if (underruns > 0) {
    setStatusValue('dbg-worklet', 'Running (underruns)', 'warn');
  } else {
    setStatusValue('dbg-worklet', 'Running', 'ok');
  }

  setText('dbg-worklet-sent', msg.workerMessagesSent ?? '—');
  setText('dbg-worklet-received', msg.workerMessagesReceived ?? '—');
  setText('dbg-underruns', underruns);
}

function initializeDebugPanelDefaults() {
  setStatusValue('dbg-websocket', 'Disconnected', 'bad');
  setStatusValue('dbg-worker', 'Not ready', 'warn');
  setStatusValue('dbg-worklet', 'Not ready', 'warn');

  setText('dbg-masking', maskingCheckbox.checked ? 'Enabled' : 'Disabled');
  setText('dbg-muted', 'No');
  setText('dbg-peers', '0');
  setText('dbg-mic-level', '—');

  setText('dbg-model', modelName || '—');
  setText('dbg-room', roomName || '—');
  setText('dbg-hop', '—');
  setText('dbg-nfft', '—');
  setText('dbg-inputs', '—');
  setText('dbg-chunk', '—');
  setText('dbg-samplerate', '16000');
  setText('dbg-preprocessing', '—');

  setText('dbg-worker-frames-in', '—');
  setText('dbg-worker-frames-out', '—');
  setText('dbg-worker-dropped', '—');
  setText('dbg-worklet-sent', '—');
  setText('dbg-worklet-received', '—');
  setText('dbg-underruns', '—');
  setText('dbg-transmission-mode', '—');

  updateTransmissionModeEnabledState();
  updateProcessingChip();
}

function setupSignalSelectors() {
  leftSignalSelect.addEventListener('change', (e) => {
    app.preferredSignals.left = e.target.value;
    rerenderPanelsOnSelectionChange();
  });

  rightSignalSelect.addEventListener('change', (e) => {
    app.preferredSignals.right = e.target.value;
    rerenderPanelsOnSelectionChange();
  });

  app.preferredSignals.left = leftSignalSelect.value;
  app.preferredSignals.right = rightSignalSelect.value;

  refreshPanelLabels();
}

// ------------------------------------------------------------
// Config / worker setup
// ------------------------------------------------------------

async function loadModelConfig(name) {
  const res = await fetch(`/static/configs/${name}.json`);
  if (!res.ok) {
    throw new Error(`Failed to load config for "${name}": ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

// app.config always belongs to the currently selected model; switchModel()
// replaces both together.
async function ensureConfig() {
  if (!app.config) {
    app.config = await loadModelConfig(modelName);
    updateStaticDebugInfo();
    updateXAxisLabels();
    updateSignalAvailabilityFromConfig();
    updateTransmissionModeOptionsFromConfig();
  }
  return app.config;
}

function ensureWorkers() {
  if (!app.mlWorker) {
    // Settled by the worker's 'ready' / 'error' message
    app.workerReadyPromise = new Promise((resolve, reject) => {
      app.workerReadyResolve = resolve;
      app.workerReadyReject = reject;
    });
    // Nothing may await it before Start; swallow to avoid an unhandled rejection.
    app.workerReadyPromise.catch(() => {});

    app.mlWorker = new Worker('/static/js/ml-inference-worker.js');
    app.mlWorker.onmessage = onMlWorkerMessage;
    app.mlWorker.onerror = (e) => {
      console.error('ML worker error:', e);
      app.workerReady = false;
      if (app.workerReadyReject) app.workerReadyReject(new Error('ML worker failed to load'));
      setStatusValue('dbg-worker', 'Error', 'bad');
      updateUiStateDebug();
    };
  }

  if (!spectrogramsSupported) return;

  if (!app.specWorkerNoisy) {
    app.specWorkerNoisy = new Worker('/static/js/spec-worker.js');
  }

  if (!app.specWorkerProcessed) {
    app.specWorkerProcessed = new Worker('/static/js/spec-worker.js');
  }
}

async function initWorkers() {
  ensureWorkers();
  const config = await ensureConfig();

  app.mlWorker.postMessage({
    type: 'init',
    name: modelName,
    config: withResolvedDelayCompensation(config)
  });

  if (spectrogramsSupported && !app.canvasAttached) {
    app.specWorkerNoisy.postMessage({ type: 'canvas', canvas: specCanvas }, [specCanvas]);
    app.specWorkerProcessed.postMessage({ type: 'canvas', canvas: specCanvasProcessed }, [specCanvasProcessed]);
    app.canvasAttached = true;

    // Size both backing stores to their displayed size and keep them in sync
    // on layout / orientation / DPR changes.
    setupSpectrogramResize();
  }
}

function onMlWorkerMessage(e) {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'ready':
      app.workerReady = true;
      if (app.workerReadyResolve) app.workerReadyResolve();
      setStatusValue('dbg-worker', 'Ready', 'ok');
      updateUiStateDebug();
      break;

    case 'error':
      if (msg.stage === 'calibrate-delay') {
        // don't mark the whole worker as unready over it.
        console.warn('Delay calibration failed:', msg.message);
        finishDelayCalibrationUi(`Measurement failed: ${msg.message}`);
        break;
      }

      console.error(`ML worker ${msg.stage || 'unknown'} error:`, msg.message);
      app.workerReady = false;
      if (msg.stage === 'initialize' && app.workerReadyReject) {
        app.workerReadyReject(new Error(msg.message || 'model initialization failed'));
      }
      setStatusValue('dbg-worker', `Error: ${msg.stage || 'unknown'}`, 'bad');
      updateUiStateDebug();
      break;

    case 'disposed':
      app.workerReady = false;
      break;

    case 'delay-estimate':
      handleDelayEstimate(msg);
      break;

    case 'stats':
      app.workerReady = !!msg.ready;
      updateWorkerStatsDebug(msg);
      updateUiStateDebug();
      break;

    default:
      console.log('ML worker message:', msg);
      break;
  }
}

// ------------------------------------------------------------
// WebSocket signaling
// ------------------------------------------------------------

// Same-origin by default. Serving the signaling WebSocket from the page's own
// origin means one TLS certificate and, with a self-signed dev cert, one
// browser exception. Firefox and Safari scope certificate exceptions per
// host:port, so a hardcoded second port (e.g. wss://host:8001) can never be
// trusted from a page loaded on :8000 -- the handshake fails with an opaque
// error event and no way to prompt the user. Chromium scopes its bypass per
// host, which is the only reason the split-port setup appeared to work.
//
// data-signaling-url / data-signaling-port allow pointing at a separate
// signaling server when it has a properly trusted certificate.
function signalingUrl() {
  const override = document.body.dataset.signalingUrl;
  if (override) {
    return override.replace('{room}', roomName);
  }

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = document.body.dataset.signalingPort;
  const host = port ? `${window.location.hostname}:${port}` : window.location.host;

  return `${scheme}//${host}/ws/connection/${roomName}/`;
}

function startWebsocket() {
  if (app.signaling && (
    app.signaling.readyState === WebSocket.OPEN ||
    app.signaling.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  const url = signalingUrl();
  let everOpened = false;

  app.signaling = new WebSocket(url);
  updateUiStateDebug();

  app.signaling.onopen = () => {
    everOpened = true;
    console.log('WebSocket connected:', url);
    updateUiStateDebug();

    // Controls opened before the socket was up (or across a reconnect) need the
    // room to report itself again.
    if (remoteControlEnabled()) sendSignalingMessage({ type: 'control-query', id: app.id });
  };

  app.signaling.onmessage = async (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      console.error('Invalid signaling message:', err);
      return;
    }

    if (data.id === app.id) return;

    // Model selection is meaningful whether or not we are in a call: adopting
    // it while stopped just changes what Start will load. Handled before the
    // call-setup guard below, which drops everything until we are running.
    if (data.type === 'model') {
      try {
        await switchModel(data.name, { broadcast: false });
      } catch (err) {
        console.error('Peer model switch failed:', err);
      }
      return;
    }

    // Remote control is likewise independent of call state.
    if (data.type === 'control') {
      applyRemoteCommand(data);
      return;
    }

    if (data.type === 'control-state') {
      onPeerControlState(data);
      return;
    }

    if (data.type === 'control-query') {
      // Only answer if we are actually controllable, so an opted-out device
      // does not appear in someone's control panel.
      if (remoteControlAccepted()) broadcastControlState();
      return;
    }

    if (!startButton.disabled) {
      console.log("Someone is ready, but we aren't yet, ignoring...");
      return;
    }

    try {
      switch (data.type) {
        case 'offer':
          await handleOffer(data);
          break;
        case 'answer':
          await handleAnswer(data);
          break;
        case 'candidate':
          await handleCandidate(data);
          break;
        case 'ready':
          await makeCall(data.id);
          break;
        case 'bye':
          app.peerStates.delete(data.id);
          refreshRemoteUi();
          closePeerConnection(data.id);
          if (app.peerConnections.size === 0) {
            await hangup(false);
          }
          updateUiStateDebug();
          break;
        default:
          console.log('Unhandled signaling message:', data);
          break;
      }
    } catch (err) {
      console.error('Signaling handler failed:', err);
    }
  };

  app.signaling.onclose = (e) => {
    // A close that arrives without a preceding 'open' means the handshake never
    // completed. The browser deliberately hides the reason (code 1006, empty
    // reason), so spell out the cause
    if (!everOpened) {
      console.error(
        `Signaling WebSocket never connected: ${url}\n` +
        'The handshake failed before the connection opened. Usual causes:\n' +
        `  1. TLS: the certificate for this origin is not trusted. Open ${
          url.replace(/^ws/, 'http')
        } directly and accept the certificate, then reload.\n` +
        '  2. The server is not listening / not routing /ws/ on this origin.\n' +
        `(close code ${e.code}${e.reason ? `, reason: ${e.reason}` : ', no reason given'})`
      );
    } else {
      console.log(`WebSocket closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`);
    }

    app.signaling = null;
    updateUiStateDebug();

    if (app.reconnectTimer) {
      clearTimeout(app.reconnectTimer);
    }

    app.reconnectTimer = setTimeout(() => {
      startWebsocket();
    }, 1000);
  };

  // onclose above carries the actionable diagnosis.
  app.signaling.onerror = () => {
    updateUiStateDebug();
  };
}

function sendSignalingMessage(msg) {
  if (app.signaling && app.signaling.readyState === WebSocket.OPEN) {
    app.signaling.send(JSON.stringify(msg));
  }
}

// ------------------------------------------------------------
// Channels / status ports
// ------------------------------------------------------------

function cleanupChannels() {
  for (const ch of [
    app.mlChannel,
    app.specChannel,
    app.specChannelProcessed,
    app.specChannelReference,
    app.specChannelPreprocessed,
    app.statusChannel
  ]) {
    if (!ch) continue;
    try { ch.port1.close(); } catch (_) {}
    try { ch.port2.close(); } catch (_) {}
  }

  for (const port of [
    app.specPortMic,
    app.specPortEnhanced,
    app.specPortReference,
    app.specPortPreprocessed
  ]) {
    if (!port) continue;
    try { port.onmessage = null; } catch (_) {}
    try { port.close(); } catch (_) {}
  }

  app.mlChannel = null;
  app.specChannel = null;
  app.specChannelProcessed = null;
  app.specChannelReference = null;
  app.specChannelPreprocessed = null;
  app.statusChannel = null;

  app.specPortMic = null;
  app.specPortEnhanced = null;
  app.specPortReference = null;
  app.specPortPreprocessed = null;
}


function setupChannels() {
  cleanupChannels();

  app.mlChannel = new MessageChannel();
  app.specChannel = new MessageChannel();
  app.specChannelProcessed = new MessageChannel();
  app.specChannelReference = new MessageChannel();
  app.specChannelPreprocessed = new MessageChannel();
  app.statusChannel = new MessageChannel();

  // Audio worklet <-> ML worker
  app.mlWorkletNode.port.postMessage({
    type: 'attach-worker-port',
    port: app.mlChannel.port1
  }, [app.mlChannel.port1]);

  app.mlWorker.postMessage({
    type: 'attach-ml-port',
    port: app.mlChannel.port2
  }, [app.mlChannel.port2]);

  // Main thread receives source spectrogram frames on port1 sides
  app.specPortMic = app.specChannel.port1;
  app.specPortEnhanced = app.specChannelProcessed.port1;
  app.specPortReference = app.specChannelReference.port1;
  app.specPortPreprocessed = app.specChannelPreprocessed.port1;

  app.specPortMic.onmessage = (e) => {
    handleIncomingSpectrum('mic', e.data);
  };

  app.specPortEnhanced.onmessage = (e) => {
    handleIncomingSpectrum('enhanced', e.data);
  };

  app.specPortReference.onmessage = (e) => {
    handleIncomingSpectrum('reference', e.data);
  };

  app.specPortPreprocessed.onmessage = (e) => {
    handleIncomingSpectrum('preprocessed', e.data);
  };

  // ML worker gets port2 sides and writes named source frames into them
  app.mlWorker.postMessage({
    type: 'attach-spec-port',
    port: app.specChannel.port2
  }, [app.specChannel.port2]);

  app.mlWorker.postMessage({
    type: 'attach-spec-processed-port',
    port: app.specChannelProcessed.port2
  }, [app.specChannelProcessed.port2]);

  app.mlWorker.postMessage({
    type: 'attach-spec-reference-port',
    port: app.specChannelReference.port2
  }, [app.specChannelReference.port2]);

  app.mlWorker.postMessage({
    type: 'attach-spec-preprocessed-port',
    port: app.specChannelPreprocessed.port2
  }, [app.specChannelPreprocessed.port2]);

  app.statusChannel.port1.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'stats' && msg.source === 'ml-worker') {
      updateWorkerStatsDebug(msg);
      updateUiStateDebug();
    } else if (msg.type === 'error') {
      console.error('Status channel error:', msg);
    }
  };

  app.mlWorker.postMessage({
    type: 'attach-status-port',
    port: app.statusChannel.port2
  }, [app.statusChannel.port2]);

  app.mlWorkletNode.port.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'stats') {
      app.workletReady = true;
      updateWorkletStatsDebug(msg);
      updateUiStateDebug();
    } else {
      console.log('ML worklet message:', msg);
    }
  };

  syncWorkerToUiState();

  app.workletReady = true;
  updateUiStateDebug();
}

// Everything the worker only learns from a message, in one place.
//
// A fresh worker starts from its own defaults (masking on, output 'full', no
// delay compensation), so any of these that is not re-sent silently reverts.
// That is invisible on a first Start -- the defaults happen to match the UI --
// but a model swap builds a new worker mid-session and would otherwise turn
// enhancement back on with the checkbox still unticked.
//
// Call this after any change of worker, and after the UI has settled, since
// loading a config can itself move the transmission-mode selection.
function syncWorkerToUiState() {
  if (!app.mlWorker) return;

  app.mlWorker.postMessage({
    type: 'mask-toggle',
    value: maskingCheckbox.checked
  });

  app.mlWorker.postMessage({
    type: 'set-output-selection',
    value: transmissionModeSelect.value
  });

  // Per-device calibration, which also lives only in the worker.
  const storedMs = loadStoredDelayMs(app.capture.deviceId);
  if (storedMs != null) {
    app.mlWorker.postMessage({
      type: 'set-delay-samples',
      delaySamples: Math.round((storedMs / 1000) * TARGET_SAMPLE_RATE)
    });
  }
}


// ------------------------------------------------------------
// Audio setup
// ------------------------------------------------------------

// The processing pipeline is defined at 16 kHz: hop_size, n_fft and the model's
// own feature rate all assume it. Running the graph at 16 kHz means the browser
// resamples once, at the hardware boundary, and every stage after that is
// native rate -- no resampling of our own anywhere in the hot path.
const TARGET_SAMPLE_RATE = 16000;

// Safari only exposed the unprefixed constructor in 14.1.
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

function createProcessingAudioContext() {
  if (!AudioContextCtor) {
    throw new Error('This browser has no Web Audio API support.');
  }

  let ac;
  try {
    ac = new AudioContextCtor({
      latencyHint: 'interactive',
      sampleRate: TARGET_SAMPLE_RATE
    });
  } catch (err) {
    throw new Error(
      `This browser refused an ${TARGET_SAMPLE_RATE} Hz AudioContext (${err.name}). ` +
      'The processing pipeline is defined at that rate, so the demo cannot run here. ' +
      'Chrome 74+, Firefox 74+ and Safari 14.1+ all support it.'
    );
  }

  // A browser may ignore the sampleRate option instead of throwing. Left
  // unchecked the whole pipeline would silently run at the wrong rate.
  if (ac.sampleRate !== TARGET_SAMPLE_RATE) {
    const actual = ac.sampleRate;
    try { ac.close(); } catch (_) {}
    throw new Error(
      `Requested a ${TARGET_SAMPLE_RATE} Hz AudioContext but this browser produced ` +
      `${actual} Hz. The pipeline is defined at ${TARGET_SAMPLE_RATE} Hz and does not ` +
      'resample, so it would emit incorrect audio. Aborting instead.'
    );
  }

  return ac;
}

// Report what was actually granted, e.g., a device that kept
// its own AGC or echo canceller enabled
function logMicTrackSettings(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track || typeof track.getSettings !== 'function') return;

  const s = track.getSettings();
  console.log(
    `Microphone: ${s.sampleRate ?? 'unknown'} Hz, ${s.channelCount ?? 'unknown'} ch ` +
    `(AGC=${s.autoGainControl ?? 'n/a'}, AEC=${s.echoCancellation ?? 'n/a'}, ` +
    `NS=${s.noiseSuppression ?? 'n/a'})`
  );

  if (s.sampleRate && s.sampleRate !== TARGET_SAMPLE_RATE) {
    console.log(
      `Capture is at ${s.sampleRate} Hz; the browser resamples it to ` +
      `${TARGET_SAMPLE_RATE} Hz on the way into the audio graph.`
    );
  }

  for (const [name, value] of [
    ['autoGainControl', s.autoGainControl],
    ['echoCancellation', s.echoCancellation],
    ['noiseSuppression', s.noiseSuppression]
  ]) {
    if (value === true) {
      console.warn(
        `Browser ${name} could not be disabled on this device; it is processing ` +
        'the microphone signal before our pipeline sees it.'
      );
    }
  }
}

// Resolves once the model is loaded, worker ignores frames until it is ready
async function waitForWorkerReady(timeoutMs = 15000) {
  if (app.workerReady || !app.workerReadyPromise) return;

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`Model still not ready after ${timeoutMs} ms; starting anyway.`);
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([app.workerReadyPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function showInsecureOriginWarning() {
  const chip = document.getElementById('insecure-chip');
  if (!chip) return;
  const insecure = !window.isSecureContext;
  chip.classList.toggle('d-none', !insecure);
  if (insecure) {
    console.warn(
      `Insecure origin (${window.location.protocol}//${window.location.host}): ` +
      'microphone capture, WebRTC and the wake lock are unavailable. ' +
      'Serve over https://, or reach the page as http://localhost.'
    );
  }
}

function assertSecureContext() {
  if (window.isSecureContext) return;

  throw new Error(
    `This page is served over ${window.location.protocol}//${window.location.host}, ` +
    'which browsers treat as an insecure origin — microphone access is blocked ' +
    'there. Use https://, or reach the page as http://localhost (for a phone: ' +
    'adb reverse tcp:8000 tcp:8000).'
  );
}

async function startAudio() {
  if (app.started) return;

  assertSecureContext();

  const config = await ensureConfig();
  await initWorkers();

  await waitForWorkerReady();

  app.ac = createProcessingAudioContext();

  // Safari hands back a suspended context even when construction happens inside
  // a click handler; without this the graph runs but never produces audio.
  if (app.ac.state === 'suspended') {
    try {
      await app.ac.resume();
    } catch (err) {
      console.warn('AudioContext resume failed:', err);
    }
  }

  await app.ac.audioWorklet.addModule('/static/js/ml-audio-worklet.js');

  app.mlWorkletNode = new AudioWorkletNode(app.ac, 'ml-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      config: {
        hop_size: config.hop_size,
        inputs: config.inputs
      }
    }
  });

  setupChannels();

  app.localStream = app.ac.createMediaStreamDestination();

  // sampleRate/channelCount are 'ideal', not exact: a browser that cannot
  // capture at 16 kHz mono then negotiates its own rate and the graph resamples
  // it into the context, instead of getUserMedia rejecting outright.
  app.mic = await openMicrophone();

  logMicTrackSettings(app.mic);

  readCaptureCapabilities();
  populateCaptureDevices();
  refreshCaptureUi();

  app.micStream = app.ac.createMediaStreamSource(app.mic);

  app.micGain = app.ac.createGain();
  app.micGain.gain.value = micGainLinear();
  app.txFileGain = app.ac.createGain();
  app.txFileGain.gain.value = 0.0;

  app.merger = app.ac.createChannelMerger(2);

  app.preOutput = app.ac.createGain();
  app.preOutput.gain.value = 1.0;

  // mic -> gain -> left channel into worklet
  app.micStream.connect(app.micGain);
  app.micGain.connect(app.merger, 0, 0);
  app.txFileGain.connect(app.merger, 0, 0);

  // far-end playback reference -> right channel into worklet
  app.preOutput.connect(app.merger, 0, 1);

  // merged stereo -> ML worklet -> uplink stream
  app.merger.connect(app.mlWorkletNode).connect(app.localStream);

  // play remote/far-end locally
  app.preOutput.connect(app.ac.destination);

  app.started = true;
  app.muted = false;
  app.transmitSource = 'mic';
  muteButton.textContent = 'Mute';

  startMicLevelMeter();
  requestWakeLock();          // not awaited: a refusal must not block startup

  await setTransmitSource('mic');

  updateStaticDebugInfo();
  updateDemoSpeechButton();
  updateUiStateDebug();
  updateProcessingChip();

  // Mandatory once per device
  if (needsMandatoryDelayCalibration()) {
    startDelayCalibration();
  }
}

// ------------------------------------------------------------
// Remote control of other participants
// ------------------------------------------------------------

// Commands carry an explicit value rather than "toggle", so a dropped or
// duplicated message cannot leave the two ends disagreeing
const REMOTE_NOTICE_MS = 2600;

function remoteControlEnabled() {
  return !!remoteControlEnableCheckbox?.checked;
}

function remoteControlAccepted() {
  return remoteControlAcceptCheckbox ? remoteControlAcceptCheckbox.checked : true;
}

function showRemoteNotice(text) {
  if (!remoteNoticeEl) return;

  remoteNoticeEl.textContent = text;
  remoteNoticeEl.classList.add('show');

  clearTimeout(app.remoteNoticeTimer);
  app.remoteNoticeTimer = setTimeout(() => {
    remoteNoticeEl.classList.remove('show');
  }, REMOTE_NOTICE_MS);
}

function sendRemoteCommand(action, value) {
  sendSignalingMessage({ type: 'control', action, value, id: app.id });
}

// Tell the room what we are now, so controllers can show real state.
function broadcastControlState() {
  sendSignalingMessage({
    type: 'control-state',
    muted: app.muted,
    masking: localProcessingEnabled() && maskingCheckbox.checked,
    id: app.id
  });
}

function applyRemoteCommand(msg) {
  if (!remoteControlAccepted()) return;

  switch (msg.action) {
    case 'mute':
      if (app.muted !== !!msg.value) {
        setMuted(!!msg.value);
        showRemoteNotice(msg.value
          ? 'Muted by another participant'
          : 'Unmuted by another participant');
      }
      break;

    case 'masking':
      // Locked off here; fall through to report the real state rather than
      // showing a notice for something that did not happen.
      if (!localProcessingEnabled()) break;

      if (maskingCheckbox.checked !== !!msg.value) {
        setMaskingEnabled(!!msg.value);
        showRemoteNotice(msg.value
          ? 'Enhancement switched on remotely'
          : 'Enhancement switched off remotely');
      }
      break;

    default:
      return;
  }

  broadcastControlState();
}

function onPeerControlState(msg) {
  app.peerStates.set(msg.id, {
    muted: !!msg.muted,
    masking: !!msg.masking,
    at: Date.now()
  });
  refreshRemoteUi();
}

function refreshRemoteUi() {
  if (!remoteGroup) return;

  remoteGroup.classList.toggle('d-none', !remoteControlEnabled());
  if (!remoteControlEnabled()) return;

  const states = [...app.peerStates.values()];

  if (states.length === 0) {
    if (remoteStatusEl) {
      remoteStatusEl.textContent = app.peerConnections.size > 0
        ? 'Waiting for participants to report…'
        : 'No participants';
    }
    return;
  }

  // Reflect what peers report. Mixed states show as unticked with a note,
  // rather than pretending everyone agrees.
  const allMuted = states.every((s) => s.muted);
  const allMasking = states.every((s) => s.masking);
  const mixedMute = !allMuted && states.some((s) => s.muted);
  const mixedMask = !allMasking && states.some((s) => s.masking);

  if (remoteMuteCheckbox) remoteMuteCheckbox.checked = allMuted;
  if (remoteMaskingCheckbox) remoteMaskingCheckbox.checked = allMasking;

  if (remoteStatusEl) {
    const bits = [`${states.length} participant${states.length > 1 ? 's' : ''}`];
    bits.push(mixedMute ? 'mute: mixed' : (allMuted ? 'muted' : 'unmuted'));
    bits.push(mixedMask ? 'enhancement: mixed' : (allMasking ? 'enhancement on' : 'enhancement off'));
    remoteStatusEl.textContent = bits.join(' · ');
  }
}

function setupRemoteControls() {
  if (remoteControlEnableCheckbox) {
    remoteControlEnableCheckbox.addEventListener('change', () => {
      refreshRemoteUi();
      // Ask everyone to report so the controls open with real state.
      if (remoteControlEnabled()) sendSignalingMessage({ type: 'control-query', id: app.id });
    });
  }

  remoteMuteCheckbox?.addEventListener('change', (e) => {
    sendRemoteCommand('mute', e.target.checked);
  });

  remoteMaskingCheckbox?.addEventListener('change', (e) => {
    sendRemoteCommand('masking', e.target.checked);
  });

  refreshRemoteUi();
}

// ------------------------------------------------------------
// Model switching
// ------------------------------------------------------------

// Only two config fields escape the ML worker: hop_size and inputs, which are
// the AudioWorkletNode's construction parameters.

// there are two tiers of switch:
//   same hop_size and inputs -> hand the running worklet a port to a new,
//     already-initialized worker. No graph surgery, audio keeps flowing.
//   otherwise -> rebuild the worklet node, which costs a short gap.
//
// Either way the new worker is fully loaded before anything is swapped

function workletContractOf(config) {
  return {
    hop_size: config.hop_size,
    inputs: config.inputs
  };
}

function workletContractMatches(a, b) {
  return a && b && a.hop_size === b.hop_size && a.inputs === b.inputs;
}

function setModelSwitchState(text) {
  if (modelSwitchState) modelSwitchState.textContent = text ? ` — ${text}` : '';
}

function setModelControlsEnabled(enabled) {
  if (modelSelect) modelSelect.disabled = !enabled;
}

// Build a worker and drive it to 'ready' without touching the live pipeline.
async function spawnModelWorker(name, config) {
  const worker = new Worker('/static/js/ml-inference-worker.js');

  const ready = new Promise((resolve, reject) => {
    const onMessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        worker.removeEventListener('message', onMessage);
        resolve();
      } else if (msg.type === 'error' && msg.stage === 'initialize') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(msg.message || `${name} failed to initialize`));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.onerror = () => reject(new Error(`${name} worker failed to load`));
  });

  worker.postMessage({ type: 'init', name, config });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${name} timed out while loading`)), 30000));

  try {
    await Promise.race([ready, timeout]);
  } catch (err) {
    try { worker.terminate(); } catch (_) {}
    throw err;
  }

  return worker;
}

async function switchModel(name, { broadcast = true } = {}) {
  if (!availableModels.includes(name)) {
    console.warn(`Model "${name}" is not offered in this room; ignoring.`);
    return;
  }
  if (name === modelName || app.modelSwitching) {
    if (modelSelect) modelSelect.value = modelName;
    return;
  }

  app.modelSwitching = true;
  setModelControlsEnabled(false);
  setModelSwitchState('loading…');

  const previousName = modelName;

  try {
    const config = await loadModelConfig(name);

    // Not running: just adopt it, Start will build everything from it.
    if (!app.started) {
      modelName = name;
      app.config = config;
      applyConfigToUi();
      if (broadcast) broadcastModelSelection(name);
      return;
    }

    const seamless = workletContractMatches(
      workletContractOf(config),
      workletContractOf(app.config)
    );

    const worker = await spawnModelWorker(name, config);

    // Past this point the new model is loaded; swap and drop the old one.
    const oldWorker = app.mlWorker;
    app.mlWorker = worker;
    app.mlWorker.onmessage = onMlWorkerMessage;
    app.mlWorker.onerror = (e) => {
      console.error('ML worker error:', e);
      app.workerReady = false;
      setStatusValue('dbg-worker', 'Error', 'bad');
      updateUiStateDebug();
    };
    app.workerReady = true;
    app.workerReadyPromise = Promise.resolve();
    app.workerReadyResolve = null;
    app.workerReadyReject = null;

    modelName = name;
    app.config = config;

    if (!seamless) {
      setModelSwitchState('rebuilding…');
      rebuildWorkletNode(config);
    }

    // Re-point every channel at the new worker (and new node, if rebuilt).
    setupChannels();

    if (oldWorker) {
      try { oldWorker.postMessage({ type: 'dispose' }); } catch (_) {}
      // Give the release a moment; the audio path no longer depends on it.
      setTimeout(() => { try { oldWorker.terminate(); } catch (_) {} }, 500);
    }

    // Order matters: applying the config can move the transmission mode
    applyConfigToUi();
    syncWorkerToUiState();

    clearPanel('left');
    clearPanel('right');

    if (broadcast) broadcastModelSelection(name);
  } catch (err) {
    console.error(`Switching to "${name}" failed:`, err);
    modelName = previousName;
    if (modelSelect) modelSelect.value = previousName;
    alert(`Could not switch to "${name}":\n\n${err.message || err}`);
  } finally {
    app.modelSwitching = false;
    setModelControlsEnabled(true);
    setModelSwitchState('');
    updateUiStateDebug();
  }
}

// hop_size / inputs are fixed when an AudioWorkletNode is constructed, so a
// model that changes either needs a new node spliced into the graph.
function rebuildWorkletNode(config) {
  const old = app.mlWorkletNode;

  app.mlWorkletNode = new AudioWorkletNode(app.ac, 'ml-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      config: {
        hop_size: config.hop_size,
        inputs: config.inputs
      }
    }
  });

  if (old) {
    try { old.disconnect(); } catch (_) {}
  }
  app.merger.connect(app.mlWorkletNode).connect(app.localStream);
}

// Everything the page derives from a config, in one place: called on load and
// after every switch.
function applyConfigToUi() {
  updateStaticDebugInfo();
  updateXAxisLabels();
  updateSignalAvailabilityFromConfig();
  updateTransmissionModeOptionsFromConfig();
  applyLabelSetBehavior();
  updateProcessingChip();

  if (modelSelect) modelSelect.value = modelName;
  setText('dbg-model', modelName);
}

function broadcastModelSelection(name) {
  if (!modelSyncPeersCheckbox?.checked) return;
  sendSignalingMessage({ type: 'model', name, id: app.id });
}

function setupModelSelector() {
  if (!modelSelect || !modelGroup) return;

  // A single-model room behaves exactly as before: no control at all.
  if (availableModels.length < 2) return;

  modelGroup.classList.remove('d-none');
  modelSelect.innerHTML = '';

  for (const name of availableModels) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = modelName;

  modelSelect.addEventListener('change', (e) => {
    switchModel(e.target.value);
  });
}

// ------------------------------------------------------------
// Capture settings (device + browser 3A)
// ------------------------------------------------------------

// The browser's auto gain control, echo canceller and noise suppressor off by default
// AGC can help handsets that capture very quietly

const CAPTURE_KEYS = ['autoGainControl', 'echoCancellation', 'noiseSuppression'];
const CAPTURE_LABELS = {
  autoGainControl: 'AGC',
  echoCancellation: 'AEC',
  noiseSuppression: 'NS'
};

function captureStorageKey(deviceId) {
  return `spen.capture.${deviceId || 'default'}`;
}

// Which microphone was chosen, remembered separately from the per-microphone
// settings. Without this every reload falls back to the system default, which
// on a laptop with a Bluetooth headset paired is usually the headset: opening
// its microphone drops the link from A2DP to the hands-free profile, and the
// headset switches into call mode with reduced noise cancelling.
const MIC_DEVICE_STORAGE_KEY = 'spen.capture.device';

function storedMicDeviceId() {
  try {
    return window.localStorage.getItem(MIC_DEVICE_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

// Adopt a microphone's remembered settings and show them.
function selectCaptureProfile(deviceId) {
  app.capture = loadCaptureSettings(deviceId);

  for (const key of CAPTURE_KEYS) {
    if (captureToggleEls[key]) captureToggleEls[key].checked = app.capture[key];
  }
}

function loadCaptureSettings(deviceId) {
  const out = {
    deviceId: deviceId || '',
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false
  };

  try {
    const raw = window.localStorage.getItem(captureStorageKey(deviceId));
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of CAPTURE_KEYS) {
        if (typeof saved[k] === 'boolean') out[k] = saved[k];
      }
    }
  } catch (_) {}

  return out;
}

function storeCaptureSettings() {
  try {
    const payload = {};
    for (const k of CAPTURE_KEYS) payload[k] = app.capture[k];
    window.localStorage.setItem(captureStorageKey(app.capture.deviceId), JSON.stringify(payload));
    window.localStorage.setItem(MIC_DEVICE_STORAGE_KEY, app.capture.deviceId || '');
  } catch (_) {}
}

// A remembered microphone can be gone (unplugged, or the ids reset with the
// permission), and buildAudioConstraints asks for it exactly. Fall back to the
// default instead of failing Start outright.
async function openMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(),
      video: false
    });
  } catch (err) {
    const missing = err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError');
    if (!missing || !app.capture.deviceId) throw err;

    console.warn('Remembered microphone unavailable, using the system default:', err.name);
    selectCaptureProfile('');
    storeCaptureSettings();

    return await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(),
      video: false
    });
  }
}

function buildAudioConstraints() {
  const audio = {
    latency: { ideal: 0.01 },
    sampleRate: { ideal: TARGET_SAMPLE_RATE },
    channelCount: { ideal: 1 }
  };

  // Bare booleans are `ideal`: a device that cannot honour them still opens.
  for (const k of CAPTURE_KEYS) audio[k] = app.capture[k];

  if (app.capture.deviceId) {
    audio.deviceId = { exact: app.capture.deviceId };
  }

  return audio;
}

function currentMicTrack() {
  return app.mic ? app.mic.getAudioTracks()[0] : null;
}

// A capability counts as toggleable only if the device offers both states.
function captureCapabilityFor(key) {
  const caps = app.captureCapabilities;
  if (!caps || !(key in caps)) return null;
  const v = caps[key];
  if (!Array.isArray(v)) return null;
  return v.includes(true) && v.includes(false);
}

function readCaptureCapabilities() {
  const track = currentMicTrack();
  app.captureCapabilities = null;

  if (track && typeof track.getCapabilities === 'function') {
    try {
      app.captureCapabilities = track.getCapabilities();
    } catch (_) {}
  }
}

function refreshCaptureUi() {
  const track = currentMicTrack();
  const settings = (track && typeof track.getSettings === 'function') ? track.getSettings() : null;

  for (const key of CAPTURE_KEYS) {
    const el = captureToggleEls[key];
    if (!el) continue;

    // Show what was granted where we know it, otherwise what was asked for.
    el.checked = settings && typeof settings[key] === 'boolean'
      ? settings[key]
      : app.capture[key];

    const toggleable = captureCapabilityFor(key);
    // plenty of browsers omit getCapabilities but still honour the constraint.
    el.disabled = app.captureSwitching || toggleable === false;
  }

  if (captureDeviceSelect) captureDeviceSelect.disabled = app.captureSwitching;

  const readout = document.getElementById('capture-readout');
  if (readout) {
    if (!settings) {
      readout.textContent = 'Not capturing';
    } else {
      const parts = [
        `${settings.sampleRate ?? '?'} Hz`,
        `${settings.channelCount ?? '?'} ch`
      ];
      for (const key of CAPTURE_KEYS) {
        const granted = settings[key];
        const asked = app.capture[key];
        const shown = typeof granted === 'boolean' ? (granted ? 'on' : 'off') : 'n/a';
        const mismatch = typeof granted === 'boolean' && granted !== asked;
        parts.push(`${CAPTURE_LABELS[key]}=${shown}${mismatch ? ` (asked ${asked ? 'on' : 'off'})` : ''}`);
      }
      readout.textContent = parts.join('  ');
    }
  }

  updateBrowserDspChip(settings);
}

// Anything the browser is doing to the signal has to be obvious from the main UI
function updateBrowserDspChip(settings) {
  const chip = document.getElementById('browser-dsp-chip');
  const list = document.getElementById('browser-dsp-list');
  if (!chip || !list) return;

  const active = CAPTURE_KEYS.filter((key) => {
    const granted = settings ? settings[key] : undefined;
    return typeof granted === 'boolean' ? granted : app.capture[key];
  });

  chip.classList.toggle('d-none', active.length === 0);
  list.textContent = active.map((k) => CAPTURE_LABELS[k]).join(', ');
}

async function populateCaptureDevices() {
  if (!captureDeviceSelect || !navigator.mediaDevices?.enumerateDevices) return;

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    console.warn('Could not enumerate audio devices:', err);
    return;
  }

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const previous = app.capture.deviceId;

  captureDeviceSelect.innerHTML = '';
  const dflt = document.createElement('option');
  dflt.value = '';
  dflt.textContent = 'System default';
  captureDeviceSelect.appendChild(dflt);

  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    // Labels are blank until permission has been granted at least once.
    opt.textContent = d.label || `Microphone ${i + 1}`;
    captureDeviceSelect.appendChild(opt);
  });

  const known = inputs.some((d) => d.deviceId === previous);
  captureDeviceSelect.value = known ? previous : '';

  // Labels (and stable ids) only appear once permission has been granted, so a
  // remembered device legitimately looks unknown until then; only forget it
  // when we can actually see the list.
  if (!known && previous && inputs.some((d) => d.label)) {
    selectCaptureProfile('');
    storeCaptureSettings();
  }
}

// build a new source and reconnect it to the same gain node
async function reacquireMicrophone() {
  if (!app.started || !app.ac) return;

  const previousStream = app.mic;
  const previousSource = app.micStream;

  const stream = await openMicrophone();

  const source = app.ac.createMediaStreamSource(stream);

  try { previousSource?.disconnect(); } catch (_) {}
  source.connect(app.micGain);

  app.mic = stream;
  app.micStream = source;

  try { previousStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}

  if (app.mlWorker) {
    try { app.mlWorker.postMessage({ type: 'reset' }); } catch (_) {}
  }
  if (app.mlWorkletNode) {
    try { app.mlWorkletNode.port.postMessage({ type: 'reset' }); } catch (_) {}
  }

  logMicTrackSettings(stream);
}

async function applyCaptureSettings({ deviceChanged = false } = {}) {
  storeCaptureSettings();

  if (!app.started) {
    refreshCaptureUi();
    return;
  }

  app.captureSwitching = true;
  refreshCaptureUi();

  try {
    let ok = false;

    if (!deviceChanged) {
      const track = currentMicTrack();
      if (track && typeof track.applyConstraints === 'function') {
        try {
          const wanted = {};
          for (const k of CAPTURE_KEYS) wanted[k] = { exact: app.capture[k] };
          await track.applyConstraints(wanted);

          // It can resolve without having changed anything; trust getSettings.
          const s = track.getSettings();
          ok = CAPTURE_KEYS.every((k) =>
            typeof s[k] !== 'boolean' || s[k] === app.capture[k]);
        } catch (err) {
          console.warn('applyConstraints did not take, re-acquiring:', err && err.name);
        }
      }
    }

    if (!ok) {
      await reacquireMicrophone();
    }

    readCaptureCapabilities();
  } catch (err) {
    console.error('Could not apply capture settings:', err);
    alert(`Could not apply the capture settings:\n\n${err.message || err}`);
  } finally {
    app.captureSwitching = false;
    refreshCaptureUi();
    updateUiStateDebug();
  }
}

function setupCaptureControls() {
  selectCaptureProfile(storedMicDeviceId());

  for (const key of CAPTURE_KEYS) {
    const el = captureToggleEls[key];
    if (!el) continue;
    el.checked = app.capture[key];
    el.addEventListener('change', (e) => {
      app.capture[key] = e.target.checked;
      applyCaptureSettings();
    });
  }

  if (captureDeviceSelect) {
    captureDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      // Each microphone carries its own remembered settings.
      selectCaptureProfile(deviceId);
      applyCaptureSettings({ deviceChanged: true });
      applyStoredDelayForCurrentDevice();
      updateDelayReadoutFromStorage();
    });
  }

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.('devicechange', () => {
      populateCaptureDevices();
    });
  }

  populateCaptureDevices();
  refreshCaptureUi();
}

// ------------------------------------------------------------
// Delay compensation calibration
// ------------------------------------------------------------

// Known simplification: keyed by capture device only

const DELAY_CALIBRATION_DURATION_MS = 2000;
const DELAY_CALIBRATION_MAX_LAG_MS = 500;

function delayStorageKey(deviceId) {
  return `spen.delay.${deviceId || 'default'}`;
}

function loadStoredDelayMs(deviceId) {
  try {
    const raw = window.localStorage.getItem(delayStorageKey(deviceId));
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function storeDelayMs(deviceId, ms) {
  try {
    window.localStorage.setItem(delayStorageKey(deviceId), String(ms));
  } catch (_) {}
}

function setDelayReadout(text) {
  if (delayReadoutEl) delayReadoutEl.textContent = text;
}

function updateDelayReadoutFromStorage() {
  const ms = loadStoredDelayMs(app.capture.deviceId);
  setDelayReadout(ms != null ? `Measured: ${ms.toFixed(0)} ms` : 'Not measured');
}

function withResolvedDelayCompensation(config) {
  const raw = config.preprocessing;
  if (!raw) return config;

  const storedMs = loadStoredDelayMs(app.capture.deviceId);
  if (storedMs == null) return config;

  const stages = Array.isArray(raw) ? raw : [raw];
  let changed = false;
  const resolvedStages = stages.map((stage) => {
    if (stage.type !== 'delay_compensation') return stage;
    changed = true;
    return { ...stage, delayMs: storedMs };
  });

  if (!changed) return config;
  return { ...config, preprocessing: Array.isArray(raw) ? resolvedStages : resolvedStages[0] };
}

function getAutoCalibrateDelayStage() {
  return getPreprocessingStages().find(
    (s) => s.type === 'delay_compensation' && s.enabled && s.autoCalibrate !== false
  ) || null;
}

function needsMandatoryDelayCalibration() {
  return !!getAutoCalibrateDelayStage() && loadStoredDelayMs(app.capture.deviceId) == null;
}

// Pushes a persisted delay value into the already-running worker without a full reinit.
function applyStoredDelayForCurrentDevice() {
  if (!app.mlWorker || !app.workerReady) return;
  const storedMs = loadStoredDelayMs(app.capture.deviceId);
  if (storedMs == null) return;

  app.mlWorker.postMessage({
    type: 'set-delay-samples',
    delaySamples: Math.round((storedMs / 1000) * TARGET_SAMPLE_RATE)
  });
}

// White noise burst, Hann-windowed over its full length
function createCalibrationNoiseBuffer(ac, durationMs) {
  const length = Math.round((durationMs / 1000) * ac.sampleRate);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  const denom = Math.max(1, length - 1);
  for (let i = 0; i < length; ++i) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
    data[i] = (Math.random() * 2 - 1) * hann;
  }
  return buffer;
}

function stopDelayCalibrationNode() {
  if (app.delayCalibrationNode) {
    try { app.delayCalibrationNode.stop(); } catch (_) {}
    try { app.delayCalibrationNode.disconnect(); } catch (_) {}
    app.delayCalibrationNode = null;
  }
}

function finishDelayCalibrationUi(readoutText) {
  app.delayCalibrating = false;
  stopDelayCalibrationNode();
  if (measureDelayButton) {
    measureDelayButton.disabled = false;
    measureDelayButton.textContent = 'Measure delay';
  }
  setDelayReadout(readoutText);
}

// Plays a short noise burst through the same reference path used at runtime
// (app.preOutput -> real speaker + graph reference channel) while the worker
// records raw mic/reference hops and cross-correlates them.
function startDelayCalibration() {
  if (!app.started || !app.ac || !app.preOutput || !app.mlWorker) {
    setDelayReadout('Start the session before measuring.');
    return;
  }
  if (app.muted) {
    setDelayReadout('Unmute the microphone before measuring.');
    return;
  }
  if (app.delayCalibrating) return;

  app.delayCalibrating = true;
  if (measureDelayButton) {
    measureDelayButton.disabled = true;
    measureDelayButton.textContent = 'Measuring…';
  }
  setDelayReadout('Measuring…');

  const buffer = createCalibrationNoiseBuffer(app.ac, DELAY_CALIBRATION_DURATION_MS);
  const node = app.ac.createBufferSource();
  node.buffer = buffer;
  node.connect(app.preOutput);
  node.start();
  app.delayCalibrationNode = node;

  app.mlWorker.postMessage({
    type: 'calibrate-delay',
    durationMs: DELAY_CALIBRATION_DURATION_MS,
    maxLagMs: DELAY_CALIBRATION_MAX_LAG_MS
  });
}

function handleDelayEstimate(msg) {
  const ms = msg.delayMs;
  storeDelayMs(app.capture.deviceId, ms);

  if (app.mlWorker) {
    app.mlWorker.postMessage({ type: 'set-delay-samples', delaySamples: msg.delaySamples });
  }

  const confidencePct = Number.isFinite(msg.confidence) ? (msg.confidence * 100).toFixed(0) : '—';
  finishDelayCalibrationUi(`Measured: ${ms.toFixed(0)} ms (confidence ${confidencePct}%)`);
}

function setupDelayCalibrationControls() {
  if (measureDelayButton) {
    measureDelayButton.addEventListener('click', startDelayCalibration);
  }
  updateDelayReadoutFromStorage();
}

// ------------------------------------------------------------
// Screen wake lock
// ------------------------------------------------------------

// The lock is dropped by the browser whenever the page stops being visible
// (tab switch, app switch, manual lock), and it is NOT restored automatically,
// so it has to be re-acquired on visibilitychange.

function wakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

async function requestWakeLock() {
  if (!wakeLockSupported() || app.wakeLock) return;

  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    setStatusValue('dbg-wakelock', 'Held', 'ok');

    app.wakeLock.addEventListener('release', () => {
      // browser-initiated releases too; re-acquired on visibilitychange
      app.wakeLock = null;
      setStatusValue('dbg-wakelock', app.started ? 'Released' : 'Not held',
                     app.started ? 'warn' : 'ok');
    });
  } catch (err) {
    // NotAllowedError when the document is hidden or the platform refuses
    app.wakeLock = null;
    console.warn('Screen wake lock refused:', err && err.name ? err.name : err);
    setStatusValue('dbg-wakelock', 'Refused', 'warn');
  }
}

async function releaseWakeLock() {
  const lock = app.wakeLock;
  app.wakeLock = null;

  if (lock) {
    try {
      await lock.release();
    } catch (_) {}
  }

  setStatusValue('dbg-wakelock', wakeLockSupported() ? 'Not held' : 'Unsupported',
                 wakeLockSupported() ? 'ok' : 'warn');
}

function setupWakeLock() {
  if (!wakeLockSupported()) {
    console.warn(
      'This browser has no Screen Wake Lock API; the screen may sleep during ' +
      'the demo. Chrome 84+, Edge 84+, Safari 16.4+ and Firefox 126+ support it.'
    );
    setStatusValue('dbg-wakelock', 'Unsupported', 'warn');
    return;
  }

  setStatusValue('dbg-wakelock', 'Not held', 'ok');

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.started) {
      requestWakeLock();
    }
  });
}

// ------------------------------------------------------------
// Microphone gain
// ------------------------------------------------------------

const MIC_GAIN_STORAGE_KEY = 'spen.micGainDb';

// Roughly the level the pipeline is happy with, and where the meter's marker
// sits: -26 dBFS is what the normalizing models target.
const MIC_LEVEL_TARGET_DB = -26;
const MIC_LEVEL_FLOOR_DB = -60;

function loadStoredMicGainDb() {
  try {
    const raw = window.localStorage.getItem(MIC_GAIN_STORAGE_KEY);
    if (raw === null) return 0;
    const v = Number(raw);
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;   // private mode / storage disabled
  }
}

function storeMicGainDb(db) {
  try {
    window.localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(db));
  } catch (_) {}
}

function micGainLinear() {
  return Math.pow(10, app.micGainDb / 20);
}

// Mute and the demo-audio source both need the mic silent, so the effective
// gain is the user's setting only while the mic is actually the source.
function applyMicGain() {
  if (!app.micGain || !app.ac) return;

  const micIsSource = !app.muted && app.transmitSource === 'mic';
  const target = micIsSource ? micGainLinear() : 0.0;
  const t = app.ac.currentTime;

  // Short ramp instead of a jump, so moving the slider does not click.
  const g = app.micGain.gain;
  try {
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + 0.02);
  } catch (_) {
    g.value = target;
  }
}

function setMicGainDb(db, { persist = true, updateSlider = true } = {}) {
  const min = Number(micGainSlider?.min ?? -12);
  const max = Number(micGainSlider?.max ?? 36);
  app.micGainDb = Math.min(max, Math.max(min, Math.round(db)));

  if (updateSlider && micGainSlider) micGainSlider.value = String(app.micGainDb);
  if (micGainValueLabel) {
    micGainValueLabel.textContent = `${app.micGainDb > 0 ? '+' : ''}${app.micGainDb} dB`;
  }

  setText('dbg-mic-gain', `${app.micGainDb > 0 ? '+' : ''}${app.micGainDb} dB`);

  if (persist) storeMicGainDb(app.micGainDb);
  applyMicGain();
}

function setupMicGainControls() {
  setMicGainDb(loadStoredMicGainDb(), { persist: false });

  if (micGainSlider) {
    micGainSlider.addEventListener('input', (e) => {
      setMicGainDb(Number(e.target.value), { updateSlider: false });
    });
  }

  if (micGainResetButton) {
    micGainResetButton.addEventListener('click', () => setMicGainDb(0));
  }
}

// ------------------------------------------------------------
// Input level meter
// ------------------------------------------------------------

function startMicLevelMeter() {
  if (!app.ac || !app.micGain) return;

  app.micAnalyser = app.ac.createAnalyser();
  app.micAnalyser.fftSize = 1024;
  app.micLevelBuf = new Float32Array(app.micAnalyser.fftSize);
  app.micGain.connect(app.micAnalyser);

  app.micLevelTimer = setInterval(updateMicLevel, 66);
}

function stopMicLevelMeter() {
  if (app.micLevelTimer) {
    clearInterval(app.micLevelTimer);
    app.micLevelTimer = null;
  }
  if (app.micAnalyser) {
    try { app.micAnalyser.disconnect(); } catch (_) {}
    app.micAnalyser = null;
  }
  app.micLevelBuf = null;
  app.micLevelDb = -Infinity;

  if (micLevelBar) {
    micLevelBar.style.width = '0%';
    micLevelBar.classList.remove('low', 'clip');
  }
  setText('dbg-mic-level', '—');
}

function updateMicLevel() {
  if (!app.micAnalyser || !app.micLevelBuf) return;

  app.micAnalyser.getFloatTimeDomainData(app.micLevelBuf);

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < app.micLevelBuf.length; ++i) {
    const v = app.micLevelBuf[i];
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }

  const rms = Math.sqrt(sumSq / app.micLevelBuf.length);
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  app.micLevelDb = db;

  if (micLevelBar) {
    // Map [floor, 0] dBFS onto the bar, so the marker at 65% is the target.
    const pct = Math.max(0, Math.min(100,
      ((db - MIC_LEVEL_FLOOR_DB) / (0 - MIC_LEVEL_FLOOR_DB)) * 100));
    micLevelBar.style.width = `${pct}%`;

    micLevelBar.classList.toggle('clip', peak >= 0.99);
    micLevelBar.classList.toggle('low', !(peak >= 0.99) && db < MIC_LEVEL_TARGET_DB - 12);
  }

  setText('dbg-mic-level', Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '—');
}

function setMuted(muted) {
  app.muted = muted;

  applyMicGain();

  if (!muted && app.transmitSource === 'file') {
    setTransmitSource('mic').catch((err) => {
      console.error('Failed to switch back to microphone:', err);
    });
  }

  muteButton.textContent = muted ? 'Unmute' : 'Mute';
  updateDemoSpeechButton();
  updateUiStateDebug();
}


async function ensureTransmitFileLoaded() {
  const cfg = getDemoAudioConfig();
  if (!cfg?.enabled || !cfg.url) {
    throw new Error('Demo audio is not configured');
  }

  if (app.txFileBuffer && app.txFileUrlLoaded === cfg.url) return;
  if (app.txFileLoading) return;

  app.txFileLoading = true;
  try {
    const res = await fetch(cfg.url);
    if (!res.ok) {
      throw new Error(`Failed to load demo audio: ${res.status} ${res.statusText}`);
    }

    const arr = await res.arrayBuffer();
    app.txFileBuffer = await app.ac.decodeAudioData(arr);
    app.txFileUrlLoaded = cfg.url;
  } finally {
    app.txFileLoading = false;
  }
}

function stopTransmitFileNode() {
  if (app.txFileNode) {
    try { app.txFileNode.stop(); } catch (_) {}
    try { app.txFileNode.disconnect(); } catch (_) {}
    app.txFileNode = null;
  }
}

function startTransmitFileNode() {
  if (!app.ac || !app.txFileBuffer || !app.txFileGain) return;

  stopTransmitFileNode();

  const node = app.ac.createBufferSource();
  const cfg = getDemoAudioConfig();

  node.buffer = app.txFileBuffer;
  node.loop = cfg?.loop ?? true;
  node.connect(app.txFileGain);
  node.start();

  app.txFileNode = node;
}


async function setTransmitSource(source) {
  if (source !== 'mic' && source !== 'file') return;

  app.transmitSource = source;

  if (!app.started || !app.ac) {
    updateDemoSpeechButton();
    updateUiStateDebug();
    return;
  }

  if (source === 'mic') {
    stopTransmitFileNode();

    if (app.txFileGain) app.txFileGain.gain.value = 0.0;
  } else {
    await ensureTransmitFileLoaded();
    startTransmitFileNode();

    if (app.txFileGain) app.txFileGain.gain.value = 1.0;
  }

  applyMicGain();

  updateDemoSpeechButton();
  updateUiStateDebug();
}

async function stopAudioGraph() {
  if (app.mlWorkletNode) {
    try {
      app.mlWorkletNode.port.postMessage({ type: 'reset' });
    } catch (_) {}
  }

  if (app.mlWorker) {
    try {
      app.mlWorker.postMessage({ type: 'reset' });
    } catch (_) {}
  }

  stopMicLevelMeter();
  releaseWakeLock();          // let the screen sleep again once we are idle

  if (app.micStream) {
    try { app.micStream.disconnect(); } catch (_) {}
    app.micStream = null;
  }

  if (app.micGain) {
    try { app.micGain.disconnect(); } catch (_) {}
    app.micGain = null;
  }

  stopTransmitFileNode();

  if (app.txFileGain) {
    try { app.txFileGain.disconnect(); } catch (_) {}
    app.txFileGain = null;
  }

  if (app.merger) {
    try { app.merger.disconnect(); } catch (_) {}
    app.merger = null;
  }

  if (app.preOutput) {
    try { app.preOutput.disconnect(); } catch (_) {}
    app.preOutput = null;
  }

  if (app.mlWorkletNode) {
    try { app.mlWorkletNode.disconnect(); } catch (_) {}
    app.mlWorkletNode = null;
  }

  cleanupChannels();

  if (app.localStream) {
    try {
      app.localStream.stream.getTracks().forEach((track) => track.stop());
    } catch (_) {}
    app.localStream = null;
  }

  if (app.mic) {
    try {
      app.mic.getTracks().forEach((track) => track.stop());
    } catch (_) {}
    app.mic = null;
  }

  // Capabilities belong to the track that just went away.
  app.captureCapabilities = null;
  refreshCaptureUi();

  if (app.ac) {
    try {
      await app.ac.close();
    } catch (_) {}
    app.ac = null;
  }

  app.started = false;
  app.muted = false;
  app.transmitSource = 'mic';
  app.workletReady = false;

  updateDemoSpeechButton();
  updateStaticDebugInfo();
  updateUiStateDebug();
  updateProcessingChip();
}

// ------------------------------------------------------------
// WebRTC
// ------------------------------------------------------------

async function createPeerConnection(remoteId) {
  if (app.peerConnections.has(remoteId)) {
    return app.peerConnections.get(remoteId);
  }

  const pc = new RTCPeerConnection();

  pc.onicecandidate = (e) => {
    const message = {
      type: 'candidate',
      candidate: null,
      id: app.id
    };

    if (e.candidate) {
      message.candidate = e.candidate.candidate;
      message.sdpMid = e.candidate.sdpMid;
      message.sdpMLineIndex = e.candidate.sdpMLineIndex;
    }

    sendSignalingMessage(message);
  };

  pc.ontrack = (e) => {
    if (!app.ac || !app.preOutput) return;

    const stream = e.streams[0];
    const remoteSource = app.ac.createMediaStreamSource(stream);

    let audio = app.remoteAudioElements.get(remoteId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.muted = true;
      app.remoteAudioElements.set(remoteId, audio);
    }

    audio.srcObject = stream;
    audio.play().catch((err) => {
      console.warn('Muted helper audio play failed:', err);
    });

    remoteSource.connect(app.preOutput);
  };

  if (!app.localStream) {
    throw new Error('Local stream is not ready');
  }

  app.localStream.stream.getTracks().forEach((track) => {
    pc.addTrack(track, app.localStream.stream);
  });

  app.peerConnections.set(remoteId, pc);
  updateUiStateDebug();

  return pc;
}

function closePeerConnection(remoteId) {
  const pc = app.peerConnections.get(remoteId);
  if (pc) {
    try { pc.close(); } catch (_) {}
    app.peerConnections.delete(remoteId);
  }

  const audio = app.remoteAudioElements.get(remoteId);
  if (audio) {
    try {
      audio.pause();
      audio.srcObject = null;
    } catch (_) {}
    app.remoteAudioElements.delete(remoteId);
  }

  updateUiStateDebug();
}

async function makeCall(remoteId) {
  const pc = await createPeerConnection(remoteId);
  const offer = await pc.createOffer(offerOptions);
  await pc.setLocalDescription(offer);

  sendSignalingMessage({
    type: 'offer',
    sdp: offer.sdp,
    id: app.id
  });
}

async function handleOffer(offer) {
  if (app.peerConnections.has(offer.id)) {
    console.log('Existing peer connection for id', offer.id);
    return;
  }

  const pc = await createPeerConnection(offer.id);
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  sendSignalingMessage({
    type: 'answer',
    sdp: answer.sdp,
    id: app.id
  });
}

async function handleAnswer(answer) {
  const pc = app.peerConnections.get(answer.id);
  if (!pc) {
    console.log('No peer connection for id', answer.id);
    return;
  }

  if (pc.signalingState !== 'stable') {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }
}

async function handleCandidate(candidate) {
  const pc = app.peerConnections.get(candidate.id);
  if (!pc) {
    console.log('No peer connection for id', candidate.id);
    return;
  }

  // End-of-candidates is signalled by an empty candidate string, per spec.
  // Passing null works in Chromium but makes Firefox throw a TypeError.
  if (!candidate.candidate) {
    try {
      await pc.addIceCandidate({ candidate: '', sdpMid: candidate.sdpMid ?? '0' });
    } catch (err) {
      // Not fatal: it only tells ICE that no further candidates are coming.
      console.warn('End-of-candidates signal rejected:', err);
    }
  } else {
    await pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex
    });
  }
}

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------

// The ONNX session and ORT's wasm heap live in the ML worker and are the bulk
// of what the demo holds. Releasing the session alone does not
// hand memory back; terminating the worker does.
// Paying one model compile on restart (.onnx comes from the HTTP cache).
//
// The spectrogram workers are kept: transferControlToOffscreen() can only ever
// be called once per <canvas>
// graceful: wait for the worker to acknowledge the dispose before killing it.

async function teardownWorkers({ graceful = true } = {}) {
  const worker = app.mlWorker;

  if (worker) {
    app.mlWorker = null;

    if (graceful) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          console.warn('ML worker did not acknowledge dispose; terminating anyway.');
          resolve();
        }, 500);

        worker.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'disposed') done();
        });

        try {
          worker.postMessage({ type: 'dispose' });
        } catch (_) {
          done();
        }
      });
    }

    try { worker.terminate(); } catch (_) {}
  }

  // Dropped with the worker; ensureWorkers() makes a fresh pair on restart.
  app.workerReadyPromise = null;
  app.workerReadyResolve = null;
  app.workerReadyReject = null;

  for (const worker of [app.specWorkerNoisy, app.specWorkerProcessed]) {
    if (!worker) continue;
    try { worker.postMessage({ type: 'clear' }); } catch (_) {}
  }

  app.workerReady = false;
  setStatusValue('dbg-worker', 'Not ready', 'warn');
}

async function hangup(sendBye = true) {
  if (sendBye) {
    sendSignalingMessage({
      type: 'bye',
      id: app.id
    });
  }

  for (const remoteId of [...app.peerConnections.keys()]) {
    closePeerConnection(remoteId);
  }

  await stopAudioGraph();
  await teardownWorkers();

  startButton.disabled = false;
  hangupButton.disabled = true;
  muteButton.disabled = false;
  muteButton.textContent = 'Mute';

  updateUiStateDebug();
}

// ------------------------------------------------------------
// UI events
// ------------------------------------------------------------

// Shared by the checkbox and by remote commands, so both take exactly the
// same path.
function setMaskingEnabled(enabled) {
  // A device whose label set says the processing happens elsewhere stays in
  // bypass no matter who asks.
  if (!localProcessingEnabled()) enabled = false;

  maskingCheckbox.checked = enabled;

  if (app.mlWorker) {
    app.mlWorker.postMessage({
      type: 'mask-toggle',
      value: enabled
    });
  }

  updateTransmissionModeEnabledState();
  updateUiStateDebug();
  updateProcessingChip();
}

maskingCheckbox.onchange = (e) => {
  setMaskingEnabled(e.target.checked);
  broadcastControlState();
};

transmissionModeSelect.onchange = (e) => {
  if (app.mlWorker) {
    app.mlWorker.postMessage({
      type: 'set-output-selection',
      value: e.target.value
    });
  }

  setText(
    'dbg-transmission-mode',
    transmissionModeSelect.options[transmissionModeSelect.selectedIndex]?.text || '—'
  );
};

muteButton.onclick = () => {
  setMuted(!app.muted);
  broadcastControlState();
};

demoSpeechButton.onclick = async () => {
  try {
    if (!app.started) return;

    if (app.transmitSource === 'file') {
      await setTransmitSource('mic');
    } else {
      await setTransmitSource('file');
    }
  } catch (err) {
    console.error('Demo speech toggle failed:', err);
  }
};

startButton.onclick = async () => {
  try {
    if (!app.signaling || app.signaling.readyState === WebSocket.CLOSED) {
      window.location.reload();
      return;
    }

    if (app.signaling.readyState !== WebSocket.OPEN) {
      alert('WebSocket not ready, try reloading the page.');
      return;
    }

    startButton.disabled = true;
    hangupButton.disabled = false;

    await startAudio();

    sendSignalingMessage({
      type: 'ready',
      id: app.id
    });

    // Let any controller in the room see us straight away.
    broadcastControlState();

    updateUiStateDebug();
  } catch (err) {
    console.error('Start failed:', err);

    // Microphone denial and unsupported-browser errors
    if (err && err.name === 'NotAllowedError') {
      alert('Microphone access was denied. Allow it for this site and press Start again.');
    } else if (err && err.name === 'NotFoundError') {
      alert('No microphone was found. Connect one and press Start again.');
    } else {
      alert(`Could not start audio processing:\n\n${err.message || err}`);
    }

    startButton.disabled = false;
    hangupButton.disabled = true;
    updateUiStateDebug();
  }
};

hangupButton.onclick = async () => {
  await hangup(true);
};

// Mobile browsers often skip 'beforeunload' entirely, so 'pagehide' is the
// one that actually fires when a phone closes or switches away from the tab.
let releasedOnUnload = false;

function releaseOnUnload() {
  if (releasedOnUnload) return;
  releasedOnUnload = true;

  try {
    sendSignalingMessage({ type: 'bye', id: app.id });
  } catch (_) {}

  // Stop the capture promptly so the recording indicator clears even if the
  // browser takes its time reclaiming the page.
  if (app.mic) {
    try { app.mic.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }

  try { releaseWakeLock(); } catch (_) {}
  try { teardownWorkers({ graceful: false }); } catch (_) {}
  if (app.ac) {
    try { app.ac.close(); } catch (_) {}
  }
}

window.addEventListener('pagehide', (e) => {
  // persisted means the page went into the back/forward cache and may come
  // back; tearing down then would restore a dead page. A demo holding a live
  // mic is not bfcache-eligible in practice, but do not rely on that.
  if (e.persisted) {
    try { releaseWakeLock(); } catch (_) {}
    return;
  }
  releaseOnUnload();
});

window.addEventListener('beforeunload', releaseOnUnload);

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

(async function main() {
  try {
    initializeDebugPanelDefaults();
    showInsecureOriginWarning();
    setupSignalSelectors();
    setupLabelSetControls();
    setupModelSelector();
    setupRemoteControls();
    setupMicGainControls();
    setupCaptureControls();
    setupDelayCalibrationControls();
    setupWakeLock();
    updateUiStateDebug();
    updateProcessingChip();

    await ensureConfig();
    await initWorkers();

    updateStaticDebugInfo();
    updateXAxisLabels();
    updateUiStateDebug();
    updateProcessingChip();

    startWebsocket();
  } catch (err) {
    console.error('Main init failed:', err);
    setStatusValue('dbg-worker', 'Init failed', 'bad');
  }
})();
