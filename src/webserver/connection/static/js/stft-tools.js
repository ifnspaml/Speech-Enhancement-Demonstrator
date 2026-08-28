class STFT_Tools {
    constructor(
        n_fft,
        win_length,
        hop_length,
        pad_size,
        debug = false,
        self_test_on_init = false,
        self_test_options = {},
        window_type = 'sqrt_hann',
        window_periodic = true,
        frontend_type = 'stft',
        real = true
    ) {
        this.window_type = window_type || 'sqrt_hann';
        this.window_periodic = !!window_periodic;

        this.frontend_type = frontend_type || 'stft';
        this.real = !!real;

        this.n_fft = n_fft | 0;
        this.win_length = win_length | 0;
        this.hop_length = hop_length | 0;
        this.pad_size = pad_size | 0;
        this.debug = !!debug;

        this.self_test_on_init = !!self_test_on_init;
        this.self_test_options = self_test_options || {};
        this.self_test_result = null;

        this._assert(this.n_fft > 0, "n_fft must be > 0");
        this._assert(this.hop_length > 0, "hop_length must be > 0");
        this._assert(this.pad_size >= 0, "pad_size must be >= 0");
        this._assert((this.n_fft & (this.n_fft - 1)) === 0, `n_fft (${this.n_fft}) should be a power of two for FFT.js`);
        this._assert(this.frontend_type === 'stft', `unsupported frontend_type "${this.frontend_type}"`);
        this._assert(this.win_length > 0, "win_length must be > 0");

        this.inv_n_fft = 1.0 / this.n_fft;

        this._assert(this.win_length <= this.n_fft, `win_length (${this.win_length}) must be <= n_fft (${this.n_fft})`);
        this._assert(this.win_length >= this.hop_length, `win_length (${this.win_length}) must be >= hop_length (${this.hop_length})`);

        this.overlap_len = this.win_length - this.hop_length;
        this.analysis_window = STFT_Tools.makeWindow(this.window_type, this.win_length, this.window_periodic);
        this.synthesis_window = STFT_Tools.makeWindow(this.window_type, this.win_length, this.window_periodic);
        this.window_product = new Float32Array(this.win_length);

        for (let i = 0; i < this.win_length; ++i) {
            this.window_product[i] = this.analysis_window[i] * this.synthesis_window[i];
        }

        this.Lp = this.win_length;
        this.step_size = this.hop_length;

        this.half_complex_len = this.n_fft + 2;
        this.half_bins = this.half_complex_len >> 1;
        this.packed_len = this.half_complex_len;
        this.model_frame_len = this.packed_len + 2 * this.pad_size;

        if (this.self_test_on_init) {
            const probe = this.createStream({
                self_test_on_init: true,
                self_test_options: this.self_test_options
            });
            this.self_test_result = probe.self_test_result;
        }
    }

    // Hann window. periodic=true (DFT-even, denominator = length) matches the
    // default of torch.hann_window / librosa / scipy(sym=False) that models are
    // normally trained with. periodic=false is the symmetric variant
    // (denominator = length - 1).
    static hann(length, periodic = true) {
        const w = new Float32Array(length);
        if (length === 1) {
            w[0] = 1;
            return w;
        }
        const denom = periodic ? length : (length - 1);
        for (let i = 0; i < length; ++i) {
            w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / denom));
        }
        return w;
    }

    static sqrtHann(length, periodic = true) {
        const h = STFT_Tools.hann(length, periodic);
        const w = new Float32Array(length);
        for (let i = 0; i < length; ++i) {
            w[i] = Math.sqrt(h[i]);
        }
        return w;
    }

    // Build the analysis/synthesis window from a config string.
    //   'sqrt_hann' (default): sqrt(Hann); with a matching synthesis window the
    //                          effective analysis-synthesis product is a Hann.
    //   'hann'               : plain Hann on both sides (product = Hann^2),
    //                          matching a torch.stft/torch.istft(window=hann)
    //                          training pipeline.
    // The normalized overlap-add in processSpectrum() divides by the actual
    // analysis*synthesis envelope, so reconstruction stays exact for either
    // choice; the window only changes the spectral features seen by the model,
    // which is why it must match how the model was trained.
    static makeWindow(type, length, periodic = true) {
        switch (type) {
            case 'hann':
                return STFT_Tools.hann(length, periodic);
            case undefined:
            case null:
            case 'sqrt_hann':
            case 'sqrt-hann':
                return STFT_Tools.sqrtHann(length, periodic);
            default:
                throw new Error(`STFT_Tools: unknown window type "${type}"`);
        }
    }

    createStream(options = {}) {
        const cfg = {
            frontend_type: this.frontend_type,

            n_fft: this.n_fft,
            win_length: this.win_length,
            hop_length: this.hop_length,
            pad_size: this.pad_size,
            debug: options.debug ?? this.debug,

            inv_n_fft: this.inv_n_fft,
            overlap_len: this.overlap_len,
            half_complex_len: this.half_complex_len,
            half_bins: this.half_bins,
            packed_len: this.packed_len,
            model_frame_len: this.model_frame_len,

            analysis_window: this.analysis_window,
            synthesis_window: this.synthesis_window,
            window_product: this.window_product,

            window_type: this.window_type,
            window_periodic: this.window_periodic,

            real: this.real,
            Lp: this.Lp,
            step_size: this.step_size,

            self_test_on_init: options.self_test_on_init ?? false,
            self_test_options: options.self_test_options ?? this.self_test_options
        };

        return new STFT_Stream(cfg);
    }

    validateConfiguration(testOptions = null) {
        const probe = this.createStream({
            self_test_on_init: false
        });

        const result = probe.runSelfDiagnostics(testOptions || this.self_test_options);
        this.self_test_result = result;
        return result;
    }

    getModelFrameLength() {
        return this.model_frame_len;
    }

    getHopLength() {
        return this.hop_length;
    }

    getWinLength() {
        return this.win_length;
    }

    getHalfComplexLength() {
        return this.half_complex_len;
    }

    _assert(cond, msg) {
        if (!cond) {
            throw new Error(`STFT_Tools: ${msg}`);
        }
    }
}

class STFT_Stream {
    constructor(config) {
        this.cfg = config;

        this.n_fft = config.n_fft;
        this.win_length = config.win_length;
        this.hop_length = config.hop_length;
        this.pad_size = config.pad_size;
        this.debug = !!config.debug;

        this.inv_n_fft = config.inv_n_fft;
        this.overlap_len = config.overlap_len;
        this.half_complex_len = config.half_complex_len;
        this.half_bins = config.half_bins;
        this.packed_len = config.packed_len;
        this.model_frame_len = config.model_frame_len;

        this.analysis_window = config.analysis_window;
        this.synthesis_window = config.synthesis_window;
        this.window_product = config.window_product;

        this.self_test_on_init = !!config.self_test_on_init;
        this.self_test_options = config.self_test_options || {};
        this.self_test_result = null;

        // Per-stream FFT instances for concurrency safety
        this.fft = new FFT.complex(this.n_fft, false);
        this.ifft = new FFT.complex(this.n_fft, true);

        this.win_eq_fft = (this.win_length === this.n_fft);

        // ---------- STFT state ----------
        this.stft_roll = new Float32Array(this.win_length);
        this.stft_time = new Float32Array(this.n_fft);
        this.fft_result = new Float32Array(this.n_fft * 2);
        this.half_complex = new Float32Array(this.half_complex_len);
        this.packed_spectrum = new Float32Array(this.packed_len);
        this.model_frame = new Float32Array(this.model_frame_len);

        // ---------- ISTFT state ----------
        this.unpadded = new Float32Array(this.packed_len);
        this.half_complex_in = new Float32Array(this.half_complex_len);
        this.full_spectrum = new Float32Array(this.n_fft * 2);
        this.ifft_result = new Float32Array(this.n_fft * 2);
        this.ifft_real = new Float32Array(this.n_fft);

        this.ola_buffer = new Float32Array(this.win_length);
        this.norm_buffer = new Float32Array(this.win_length);
        this.out_block = new Float32Array(this.hop_length);

        this.flush_zero_frame = new Float32Array(this.model_frame_len);

        if (this.self_test_on_init) {
            this.self_test_result = this.runSelfDiagnostics(this.self_test_options);

            if (!this.self_test_result.passed) {
                throw new Error(`STFT_Stream self-test failed: ${this._formatDiagnosticsSummary(this.self_test_result)}`);
            }
        }
    }

    _assert(cond, msg) {
        if (!cond) {
            throw new Error(`STFT_Stream: ${msg}`);
        }
    }

    _assertFloat32Array(arr, expectedLen, name) {
        if (!this.debug) return;
        if (!(arr instanceof Float32Array)) {
            throw new Error(`STFT_Stream: ${name} must be a Float32Array`);
        }
        if (arr.length !== expectedLen) {
            throw new Error(`STFT_Stream: ${name} length must be ${expectedLen}, got ${arr.length}`);
        }
    }

    _formatDiagnosticsSummary(report) {
        const parts = [];

        if (report.fftCore) {
            parts.push(
                `fftCore: passed=${report.fftCore.passed}, maxAbsErr=${report.fftCore.maxAbsErr}, correlation=${report.fftCore.correlation}`
            );
        }

        if (report.results) {
            for (const r of report.results) {
                const zm = r.zeroLagMetrics;
                const am = r.alignedMetrics;
                parts.push(
                    `${r.name}: passed=${r.passed}, delay=${r.bestLag}, zeroCorr=${zm.correlation}, alignedCorr=${am.correlation}, alignedMaxAbsErr=${am.maxAbsErr}, alignedRmsErr=${am.rmsErr}, gainRatio=${am.gainRatio}`
                );
            }
        }

        return parts.join(" | ");
    }

    getReusableModelFrameBuffer() {
        return this.model_frame;
    }

    getReusableTimeFrameBuffer() {
        return this.out_block;
    }

    _copyHalfSpectrumFromFFT(srcFullComplex, dstHalfComplex) {
        dstHalfComplex.set(srcFullComplex.subarray(0, this.half_complex_len));
    }

    _separateRealImag(srcInterleaved, dstPacked) {
        const half = this.half_bins;
        for (let k = 0; k < half; ++k) {
            const base = k << 1;
            dstPacked[k] = srcInterleaved[base];
            dstPacked[half + k] = srcInterleaved[base + 1];
        }
    }

    _joinRealImag(srcPacked, dstInterleaved) {
        const half = this.half_bins;
        for (let k = 0; k < half; ++k) {
            const base = k << 1;
            dstInterleaved[base] = srcPacked[k];
            dstInterleaved[base + 1] = srcPacked[half + k];
        }
    }

    _padPacked(srcPacked, dstModelFrame) {
        const half = this.half_bins;
        const p = this.pad_size;
        const modelHalf = this.model_frame_len >> 1;

        dstModelFrame.fill(0);
        dstModelFrame.set(srcPacked.subarray(0, half), p);
        dstModelFrame.set(srcPacked.subarray(half), modelHalf + p);
    }

    _unpadPacked(srcModelFrame, dstPacked) {
        const half = this.half_bins;
        const p = this.pad_size;
        const modelHalf = srcModelFrame.length >> 1;

        dstPacked.set(srcModelFrame.subarray(p, p + half), 0);
        dstPacked.set(srcModelFrame.subarray(modelHalf + p, modelHalf + p + half), half);
    }

    _completeSpectrum(srcHalfComplex, dstFullComplex) {
        dstFullComplex.fill(0);
        dstFullComplex.set(srcHalfComplex.subarray(0, this.half_complex_len), 0);

        for (let k = this.half_bins; k < this.n_fft; ++k) {
            const srcBin = this.n_fft - k;
            const dstBase = k << 1;
            const srcBase = srcBin << 1;
            dstFullComplex[dstBase] = srcHalfComplex[srcBase];
            dstFullComplex[dstBase + 1] = -srcHalfComplex[srcBase + 1];
        }

        dstFullComplex[1] = 0;
        if ((this.n_fft & 1) === 0) {
            const nyquistBase = this.n_fft;
            dstFullComplex[nyquistBase + 1] = 0;
        }
    }

    _discardImaginary(srcComplexTime, dstReal) {
        for (let i = 0, j = 0; i < this.n_fft; ++i, j += 2) {
            dstReal[i] = srcComplexTime[j];
        }
    }

    processFrame(inputFrame, outModelFrame = null) {
        this._assertFloat32Array(inputFrame, this.hop_length, "processFrame(inputFrame)");

        const out = outModelFrame || this.model_frame;
        this._assertFloat32Array(out, this.model_frame_len, "processFrame(outModelFrame)");

        if (this.overlap_len > 0) {
            this.stft_roll.copyWithin(0, this.hop_length);
        }

        this.stft_roll.set(inputFrame, this.overlap_len);

        if (!this.win_eq_fft) {
            this.stft_time.fill(0);
        }

        for (let i = 0; i < this.win_length; ++i) {
            this.stft_time[i] = this.stft_roll[i] * this.analysis_window[i];
        }

        this.fft.simple(this.fft_result, this.stft_time, 'real');

        this._copyHalfSpectrumFromFFT(this.fft_result, this.half_complex);
        this._separateRealImag(this.half_complex, this.packed_spectrum);
        this._padPacked(this.packed_spectrum, out);

        return out;
    }

    processSpectrum(modelFrame, outTimeFrame = null) {
        this._assertFloat32Array(modelFrame, this.model_frame_len, "processSpectrum(modelFrame)");

        const out = outTimeFrame || this.out_block;
        this._assertFloat32Array(out, this.hop_length, "processSpectrum(outTimeFrame)");

        this._unpadPacked(modelFrame, this.unpadded);
        this._joinRealImag(this.unpadded, this.half_complex_in);
        this._completeSpectrum(this.half_complex_in, this.full_spectrum);

        this.ifft.simple(this.ifft_result, this.full_spectrum);

        for (let i = 0; i < this.ifft_result.length; ++i) {
            this.ifft_result[i] *= this.inv_n_fft;
        }

        this._discardImaginary(this.ifft_result, this.ifft_real);

        if (this.overlap_len > 0) {
            this.ola_buffer.copyWithin(0, this.hop_length);
            this.norm_buffer.copyWithin(0, this.hop_length);
        }

        this.ola_buffer.fill(0, this.overlap_len);
        this.norm_buffer.fill(0, this.overlap_len);

        for (let i = 0; i < this.win_length; ++i) {
            const weighted = this.ifft_real[i] * this.synthesis_window[i];
            this.ola_buffer[i] += weighted;
            this.norm_buffer[i] += this.window_product[i];
        }

        for (let i = 0; i < this.hop_length; ++i) {
            const denom = this.norm_buffer[i];
            out[i] = denom > 1e-8 ? this.ola_buffer[i] / denom : 0;
        }

        return out;
    }

    flushISTFT() {
        const blocks = [];
        const needed = Math.ceil(this.overlap_len / this.hop_length);

        for (let i = 0; i < needed; ++i) {
            const block = new Float32Array(this.hop_length);
            block.set(this.processSpectrum(this.flush_zero_frame));
            blocks.push(block);
        }

        return blocks;
    }

    testFFTCoreIdentity(opts = {}) {
        const eps = opts.eps ?? 1e-8;

        this.reset();

        const x = new Float32Array(this.n_fft);
        x[1 % this.n_fft] = 1.0;
        x[3 % this.n_fft] = -0.5;
        x[7 % this.n_fft] = 0.25;
        if (this.n_fft > 15) x[15] = -0.125;

        const X = new Float32Array(this.n_fft * 2);
        const Y = new Float32Array(this.n_fft * 2);
        const y = new Float32Array(this.n_fft);

        this.fft.simple(X, x, 'real');
        this.ifft.simple(Y, X);

        for (let i = 0; i < Y.length; ++i) {
            Y[i] *= this.inv_n_fft;
        }

        for (let i = 0, j = 0; i < this.n_fft; ++i, j += 2) {
            y[i] = Y[j];
        }

        let maxAbsErr = 0;
        let sumSqErr = 0;
        let sumSqX = 0;
        let sumSqY = 0;
        let dot = 0;

        for (let i = 0; i < this.n_fft; ++i) {
            const err = y[i] - x[i];
            const ae = Math.abs(err);
            if (ae > maxAbsErr) maxAbsErr = ae;
            sumSqErr += err * err;
            sumSqX += x[i] * x[i];
            sumSqY += y[i] * y[i];
            dot += x[i] * y[i];
        }

        const rmsErr = Math.sqrt(sumSqErr / this.n_fft);
        const gainRatio = Math.sqrt(sumSqY / Math.max(sumSqX, eps));
        const correlation = dot / Math.max(Math.sqrt(sumSqX * sumSqY), eps);

        const maxAbsTol = opts.maxAbsTol ?? 1e-5;
        const rmsTol = opts.rmsTol ?? 1e-6;
        const corrTol = opts.corrTol ?? 0.99999;
        const gainTol = opts.gainTol ?? 1e-5;

        const passed =
            maxAbsErr <= maxAbsTol &&
            rmsErr <= rmsTol &&
            Math.abs(gainRatio - 1.0) <= gainTol &&
            correlation >= corrTol;

        this.reset();

        return {
            passed,
            maxAbsErr,
            rmsErr,
            gainRatio,
            correlation,
            input: x,
            output: y
        };
    }

    _computeMetricsForLag(input, reconstructed, lag, opts = {}) {
        const eps = opts.eps ?? 1e-8;
        const trimStart = opts.trimStart ?? this.win_length;
        const trimEnd = opts.trimEnd ?? this.win_length;

        let inStart = 0;
        let outStart = 0;

        if (lag >= 0) {
            outStart = lag;
        } else {
            inStart = -lag;
        }

        const usable = Math.min(input.length - inStart, reconstructed.length - outStart);
        if (usable <= 0) {
            return null;
        }

        const cmpInStart = inStart + trimStart;
        const cmpOutStart = outStart + trimStart;
        const cmpLen = usable - trimStart - trimEnd;

        if (cmpLen <= 0) {
            return null;
        }

        let maxAbsErr = 0;
        let sumSqErr = 0;
        let sumSqIn = 0;
        let sumSqOut = 0;
        let dot = 0;

        for (let i = 0; i < cmpLen; ++i) {
            const x = input[cmpInStart + i];
            const y = reconstructed[cmpOutStart + i];
            const err = y - x;
            const ae = Math.abs(err);

            if (ae > maxAbsErr) maxAbsErr = ae;
            sumSqErr += err * err;
            sumSqIn += x * x;
            sumSqOut += y * y;
            dot += x * y;
        }

        const rmsErr = Math.sqrt(sumSqErr / cmpLen);
        const inputRms = Math.sqrt(sumSqIn / cmpLen);
        const outputRms = Math.sqrt(sumSqOut / cmpLen);
        const gainRatio = outputRms / Math.max(inputRms, eps);
        const correlation = dot / Math.max(Math.sqrt(sumSqIn * sumSqOut), eps);

        return {
            lag,
            comparedSamples: cmpLen,
            inputStart: cmpInStart,
            outputStart: cmpOutStart,
            maxAbsErr,
            rmsErr,
            inputRms,
            outputRms,
            gainRatio,
            correlation,
            trimStart,
            trimEnd
        };
    }

    _measureAlignment(input, reconstructed, opts = {}) {
        const maxLag = opts.maxLag ?? Math.max(this.win_length * 2, this.overlap_len * 2, this.hop_length * 4);
        let best = null;

        for (let lag = -maxLag; lag <= maxLag; ++lag) {
            const m = this._computeMetricsForLag(input, reconstructed, lag, opts);
            if (!m) continue;

            if (
                !best ||
                m.correlation > best.correlation ||
                (m.correlation === best.correlation && m.rmsErr < best.rmsErr)
            ) {
                best = m;
            }
        }

        return best;
    }

    validateRoundTrip(testSignal, opts = {}) {
        const wasDebug = this.debug;
        this.debug = true;
        this._assertFloat32Array(testSignal, testSignal.length, "validateRoundTrip(testSignal)");

        const waveformTol = opts.waveformTol ?? 1e-3;
        const rmsTol = opts.rmsTol ?? 1e-4;
        const gainTol = opts.gainTol ?? 1e-2;
        const corrTol = opts.corrTol ?? 0.999;
        const maxAllowedDelay = opts.maxAllowedDelay ?? Math.max(this.win_length, this.overlap_len);

        this.reset();

        const hop = this.hop_length;
        const blocks = [];
        const modelBuf = new Float32Array(this.model_frame_len);

        for (let pos = 0; pos < testSignal.length; pos += hop) {
            const inBlock = new Float32Array(hop);
            const remaining = Math.min(hop, testSignal.length - pos);
            inBlock.set(testSignal.subarray(pos, pos + remaining), 0);

            this.processFrame(inBlock, modelBuf);

            const outBlock = new Float32Array(hop);
            outBlock.set(this.processSpectrum(modelBuf));
            blocks.push(outBlock);
        }

        for (const tailBlock of this.flushISTFT()) {
            blocks.push(tailBlock);
        }

        const reconstructed = new Float32Array(blocks.length * hop);
        for (let i = 0; i < blocks.length; ++i) {
            reconstructed.set(blocks[i], i * hop);
        }

        const zeroLagMetrics = this._computeMetricsForLag(testSignal, reconstructed, 0, opts);
        const bestAlignment = this._measureAlignment(testSignal, reconstructed, opts);

        if (!zeroLagMetrics || !bestAlignment) {
            this.reset();
            this.debug = wasDebug;
            throw new Error("STFT_Stream: validateRoundTrip could not compute alignment metrics");
        }

        const alignedMetrics = bestAlignment;
        const bestLag = bestAlignment.lag;

        const passed =
            Math.abs(bestLag) <= maxAllowedDelay &&
            alignedMetrics.maxAbsErr <= waveformTol &&
            alignedMetrics.rmsErr <= rmsTol &&
            Math.abs(alignedMetrics.gainRatio - 1.0) <= gainTol &&
            alignedMetrics.correlation >= corrTol;

        this.reset();
        this.debug = wasDebug;

        return {
            passed,
            bestLag,
            zeroLagMetrics,
            alignedMetrics,
            tolerances: {
                waveformTol,
                rmsTol,
                gainTol,
                corrTol,
                maxAllowedDelay,
                trimStart: opts.trimStart ?? this.win_length,
                trimEnd: opts.trimEnd ?? this.win_length
            },
            reconstructed
        };
    }

    static makeValidationSignal(length, sampleRate = 16000) {
        const x = new Float32Array(length);

        for (let n = 0; n < length; ++n) {
            const t = n / sampleRate;
            x[n] =
                0.5 * Math.sin(2 * Math.PI * 220 * t) +
                0.3 * Math.sin(2 * Math.PI * 440 * t + 0.2) +
                0.15 * Math.sin(2 * Math.PI * 880 * t + 0.7);
        }

        return x;
    }

    runSelfDiagnostics(opts = {}) {
        const sampleRate = opts.sampleRate ?? 16000;
        const length = opts.length ?? Math.max(sampleRate, this.win_length * 8);
        const testOpts = opts.testOpts || {};
        const includeFFTCore = opts.includeFFTCore ?? true;

        const report = {
            passed: true,
            fftCore: null,
            results: []
        };

        if (includeFFTCore) {
            report.fftCore = this.testFFTCoreIdentity(opts.fftCoreOpts || {});
            if (!report.fftCore.passed) {
                report.passed = false;
            }
        }

        const tests = [];

        const impulse = new Float32Array(length);
        impulse[Math.min(Math.floor(length / 4), length - 1)] = 1.0;
        tests.push({ name: "impulse", signal: impulse });

        const sine = new Float32Array(length);
        for (let n = 0; n < length; ++n) {
            sine[n] = 0.8 * Math.sin(2 * Math.PI * 440 * n / sampleRate);
        }
        tests.push({ name: "sine440", signal: sine });

        const twoTone = new Float32Array(length);
        for (let n = 0; n < length; ++n) {
            const t = n / sampleRate;
            twoTone[n] =
                0.55 * Math.sin(2 * Math.PI * 220 * t) +
                0.25 * Math.sin(2 * Math.PI * 880 * t + 0.3);
        }
        tests.push({ name: "two_tone", signal: twoTone });

        const noise = new Float32Array(length);
        for (let n = 0; n < length; ++n) {
            noise[n] = 0.2 * (2 * Math.random() - 1);
        }
        tests.push({ name: "noise", signal: noise });

        const chirp = new Float32Array(length);
        for (let n = 0; n < length; ++n) {
            const t = n / sampleRate;
            const f0 = 80;
            const f1 = 0.45 * sampleRate;
            const frac = n / Math.max(length - 1, 1);
            const f = f0 + (f1 - f0) * frac;
            chirp[n] = 0.5 * Math.sin(2 * Math.PI * f * t);
        }
        tests.push({ name: "chirp", signal: chirp });

        for (const t of tests) {
            const res = this.validateRoundTrip(t.signal, testOpts);
            report.results.push({
                name: t.name,
                passed: res.passed,
                bestLag: res.bestLag,
                zeroLagMetrics: res.zeroLagMetrics,
                alignedMetrics: res.alignedMetrics,
                tolerances: res.tolerances
            });
            if (!res.passed) {
                report.passed = false;
            }
        }

        this.reset();
        return report;
    }

    reset() {
        this.stft_roll.fill(0);
        this.stft_time.fill(0);
        this.fft_result.fill(0);
        this.half_complex.fill(0);
        this.packed_spectrum.fill(0);
        this.model_frame.fill(0);

        this.unpadded.fill(0);
        this.half_complex_in.fill(0);
        this.full_spectrum.fill(0);
        this.ifft_result.fill(0);
        this.ifft_real.fill(0);

        this.ola_buffer.fill(0);
        this.norm_buffer.fill(0);
        this.out_block.fill(0);
    }
}
