class SampleFifo {
    constructor(capacitySamples) {
        this.capacity = capacitySamples;
        this.buffer = new Float32Array(capacitySamples);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.count = 0;

        this.overruns = 0;
        this.underruns = 0;
    }

    clear() {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.count = 0;
    }

    availableWrite() {
        return this.capacity - this.count;
    }

    pushBlock(src) {
        const n = src.length;

        if (n > this.capacity) {
            const start = n - this.capacity;
            this.clear();
            this.pushBlock(src.subarray(start));
            this.overruns++;
            return;
        }

        if (n > this.availableWrite()) {
            const toDrop = n - this.availableWrite();
            this.readIndex = (this.readIndex + toDrop) % this.capacity;
            this.count -= toDrop;
            this.overruns++;
        }

        let firstPart = Math.min(n, this.capacity - this.writeIndex);
        this.buffer.set(src.subarray(0, firstPart), this.writeIndex);

        const remaining = n - firstPart;
        if (remaining > 0) {
            this.buffer.set(src.subarray(firstPart, firstPart + remaining), 0);
        }

        this.writeIndex = (this.writeIndex + n) % this.capacity;
        this.count += n;
    }

    popTo(dst) {
        const n = dst.length;

        if (this.count < n) {
            const available = this.count;

            if (available > 0) {
                let firstPart = Math.min(available, this.capacity - this.readIndex);
                dst.set(this.buffer.subarray(this.readIndex, this.readIndex + firstPart), 0);

                const remaining = available - firstPart;
                if (remaining > 0) {
                    dst.set(this.buffer.subarray(0, remaining), firstPart);
                }

                this.readIndex = (this.readIndex + available) % this.capacity;
                this.count -= available;
            }

            dst.fill(0, available);
            this.underruns++;
            return;
        }

        let firstPart = Math.min(n, this.capacity - this.readIndex);
        dst.set(this.buffer.subarray(this.readIndex, this.readIndex + firstPart), 0);

        const remaining = n - firstPart;
        if (remaining > 0) {
            dst.set(this.buffer.subarray(0, remaining), firstPart);
        }

        this.readIndex = (this.readIndex + n) % this.capacity;
        this.count -= n;
    }
}

class MLAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.frame_length = 128;

        const processorOptions = (options && options.processorOptions) || {};
        const config = processorOptions.config || {};

        this.hop_length = config.hop_size || 256;
        this.inputsCount = config.inputs || 1;

        if (this.hop_length <= 0 || (this.hop_length % this.frame_length) !== 0) {
            throw new Error(
                `hop_length (${this.hop_length}) must be a positive multiple of ${this.frame_length}`
            );
        }

        this.blocksPerHop = this.hop_length / this.frame_length;

        this.inputWritePos = 0;

        this.micFillBuffer = new Float32Array(this.hop_length);
        this.micSendBuffer = new Float32Array(this.hop_length);

        if (this.inputsCount > 1) {
            this.spkFillBuffer = new Float32Array(this.hop_length);
            this.spkSendBuffer = new Float32Array(this.hop_length);
        } else {
            this.spkFillBuffer = null;
            this.spkSendBuffer = null;
        }

        this.outputFifo = new SampleFifo(this.hop_length * 16);

        this.zero128 = new Float32Array(this.frame_length);

        this.workerPort = null;

        this.statsCounter = 0;
        this.workerMessagesSent = 0;
        this.workerMessagesReceived = 0;

        this.port.onmessage = (e) => {
            const data = e.data;

            switch (data.type) {
                case 'attach-worker-port':
                    this.attachWorkerPort(data.port);
                    break;
                case 'reset':
                    this.resetState();
                    break;
            }
        };
    }

    attachWorkerPort(port) {
        this.workerPort = port;
        this.workerPort.onmessage = (e) => {
            const out = e.data;

            if (!(out instanceof Float32Array)) return;
            if (out.length !== this.hop_length) return;

            this.outputFifo.pushBlock(out);
            this.workerMessagesReceived++;
        };
    }

    resetState() {
        this.inputWritePos = 0;

        this.micFillBuffer.fill(0);
        this.micSendBuffer.fill(0);

        if (this.spkFillBuffer) this.spkFillBuffer.fill(0);
        if (this.spkSendBuffer) this.spkSendBuffer.fill(0);

        this.outputFifo.clear();
    }

    sendHopToWorker() {
        if (!this.workerPort) return;

        let tmp = this.micSendBuffer;
        this.micSendBuffer = this.micFillBuffer;
        this.micFillBuffer = tmp;

        const payload = new Array(this.inputsCount);
        payload[0] = this.micSendBuffer;

        if (this.inputsCount > 1) {
            tmp = this.spkSendBuffer;
            this.spkSendBuffer = this.spkFillBuffer;
            this.spkFillBuffer = tmp;
            payload[1] = this.spkSendBuffer;
        }

        this.workerPort.postMessage(payload);
        this.workerMessagesSent++;
        this.inputWritePos = 0;
    }

    maybePostStats() {
        this.statsCounter++;
        if (this.statsCounter < 200) return;
        this.statsCounter = 0;

        this.port.postMessage({
            type: 'stats',
            source: 'ml-worklet',
            workerMessagesSent: this.workerMessagesSent,
            workerMessagesReceived: this.workerMessagesReceived,
            outputUnderruns: this.outputFifo.underruns,
            outputOverruns: this.outputFifo.overruns
        });
    }

    process(inputList, outputList) {
        const input = inputList[0];
        const output = outputList[0];

        if (!output || !output[0]) {
            return true;
        }

        const outCh0 = output[0];
        const micIn = input && input[0] ? input[0] : this.zero128;
        const spkIn = (this.inputsCount > 1 && input && input[1]) ? input[1] : this.zero128;

        this.micFillBuffer.set(micIn, this.inputWritePos);

        if (this.inputsCount > 1) {
            this.spkFillBuffer.set(spkIn, this.inputWritePos);
        }

        this.inputWritePos += this.frame_length;

        if (this.inputWritePos >= this.hop_length) {
            this.sendHopToWorker();
        }

        this.outputFifo.popTo(outCh0);
        this.maybePostStats();

        return true;
    }
}

registerProcessor('ml-processor', MLAudioProcessor);
