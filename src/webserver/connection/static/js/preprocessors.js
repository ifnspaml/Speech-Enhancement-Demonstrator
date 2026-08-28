// Static, integer-sample delay applied to one raw time-domain channel before
// STFT. Compensates device-internal latency between the reference (loudspeaker)
// signal and the microphone capture, which an STFT-domain echo canceller with a
// bounded tap length cannot itself absorb if the true delay exceeds its span.
class DelayCompensator {
    constructor({ channelIndex = 1, delaySamples = 0, hopLength = 0 } = {}) {
        this.channelIndex = channelIndex | 0;
        this.hopLength = hopLength | 0;
        this.delaySamples = 0;
        this.ring = null;
        this.writePos = 0;
        this.scratch = this.hopLength > 0 ? new Float32Array(this.hopLength) : null;

        this.setDelaySamples(delaySamples);
    }

    // Resizes/clears the ring buffer for a new static delay value. Safe to call
    // live (e.g. after a calibration measurement) without recreating the stage.
    setDelaySamples(delaySamples) {
        this.delaySamples = Math.max(0, delaySamples | 0);
        const bufferLength = this.delaySamples + this.hopLength;
        this.ring = bufferLength > 0 ? new Float32Array(bufferLength) : null;
        this.writePos = 0;
    }

    reset() {
        if (this.ring) this.ring.fill(0);
        this.writePos = 0;
    }

    // Delays inputData[channelIndex] in place by delaySamples using a circular
    // buffer. A delaySamples of 0 is a no-op passthrough.
    process(inputData) {
        if (this.delaySamples === 0 || !this.ring) return inputData;

        const src = inputData[this.channelIndex];
        const ring = this.ring;
        const bufLen = ring.length;
        const out = this.scratch;

        for (let i = 0; i < src.length; ++i) {
            const readPos = (this.writePos - this.delaySamples + bufLen) % bufLen;
            out[i] = ring[readPos];
            ring[this.writePos] = src[i];
            this.writePos = (this.writePos + 1) % bufLen;
        }

        src.set(out);
        return inputData;
    }
}

// One-shot normalized cross-correlation search used by delay calibration: finds
// the lag (in samples) at which `micBuffer` best matches a delayed `refBuffer`.
// Not used in the per-frame hot path, so a direct O(N*maxLag) search is fine.
function estimateDelaySamples(refBuffer, micBuffer, { minLagSamples = 0, maxLagSamples } = {}) {
    const maxLag = Math.min(
        maxLagSamples ?? (micBuffer.length - 1),
        micBuffer.length - 1
    );
    const minLag = Math.max(0, minLagSamples | 0);

    let bestLag = minLag;
    let bestCorr = -Infinity;

    for (let lag = minLag; lag <= maxLag; ++lag) {
        const n = Math.min(refBuffer.length, micBuffer.length - lag);
        if (n <= 0) continue;

        let cross = 0;
        let refEnergy = 0;
        let micEnergy = 0;

        for (let i = 0; i < n; ++i) {
            const r = refBuffer[i];
            const m = micBuffer[i + lag];
            cross += r * m;
            refEnergy += r * r;
            micEnergy += m * m;
        }

        const denom = Math.sqrt(refEnergy * micEnergy);
        const corr = denom > 1e-12 ? cross / denom : 0;

        if (corr > bestCorr) {
            bestCorr = corr;
            bestLag = lag;
        }
    }

    return { delaySamples: bestLag, confidence: Math.max(0, bestCorr) };
}

// Produces the diffusion latent z.
// Passing white noise through the same analysis stream reproduces the training
// distribution exactly and tracks any window/n_fft change
class DiffusionNoiseGenerator {
    constructor({
        modelFrameLength,
        seed = null,
        scale = 1.0,
        stftTools = null,
        hopLength = 0
    } = {}) {
        this.modelFrameLength = modelFrameLength;
        this.scale = scale;

        this._hasSpare = false;
        this._spare = 0.0;

        // Optional deterministic RNG hook later if desired.
        // For now use Math.random().
        this._rng = Math.random;

        this.stream = stftTools ? stftTools.createStream() : null;
        this.hopLength = hopLength;
        this.timeBuffer = this.stream ? new Float32Array(hopLength) : null;

        if (!this.stream) {
            console.warn(
                'DiffusionNoiseGenerator: no STFT stream supplied, falling back to ' +
                'per-bin Gaussians. The noise scale will not match training.'
            );
        }
    }

    reset() {
        this._hasSpare = false;
        this._spare = 0.0;
        if (this.stream) this.stream.reset();
    }

    _gaussian() {
        if (this._hasSpare) {
            this._hasSpare = false;
            return this._spare * this.scale;
        }

        let u = 0.0;
        let v = 0.0;
        let s = 0.0;

        do {
            u = this._rng() * 2.0 - 1.0;
            v = this._rng() * 2.0 - 1.0;
            s = u * u + v * v;
        } while (s === 0.0 || s >= 1.0);

        const mul = Math.sqrt(-2.0 * Math.log(s) / s);
        this._spare = v * mul;
        this._hasSpare = true;

        return (u * mul) * this.scale;
    }

    applyModelFrames(micModelFrame, rxModelFrame, outNoiseModelFrame, update=true) {
        if (this.stream) {
            const buf = this.timeBuffer;
            for (let i = 0; i < buf.length; ++i) {
                buf[i] = this._gaussian();
            }
            this.stream.processFrame(buf, outNoiseModelFrame);
            return;
        }

        const n = outNoiseModelFrame.length;
        for (let i = 0; i < n; ++i) {
            outNoiseModelFrame[i] = this._gaussian();
        }
    }
}


self.DiffusionNoiseGenerator = DiffusionNoiseGenerator;
self.DelayCompensator = DelayCompensator;
self.estimateDelaySamples = estimateDelaySamples;
