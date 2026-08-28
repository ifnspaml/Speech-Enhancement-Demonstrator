class CircularBuffer {
    constructor(bufferLength) {
        this.buffer = [];
        this.start = 0;
        this.end = 0;
        this.bufferLength = bufferLength;
    }

    push(element) {
        if (this.buffer.length === this.bufferLength) {
            this.buffer[this.end] = element;
            this.start = (this.start + 1) % this.bufferLength;
        } else {
            this.buffer.push(element);
        }
        this.end = (this.end + 1) % this.bufferLength;
    }

    get(i) {
        if (i < 0 || i >= this.buffer.length) return null;
        return this.buffer[(this.start + i) % this.bufferLength];
    }

    getLast(i) {
        if (i < 0 || i >= this.buffer.length) return null;
        const idx = (this.end + this.bufferLength - 1 - i) % this.bufferLength;
        return this.buffer[idx];
    }

    clear() {
        this.buffer.length = 0;
        this.start = 0;
        this.end = 0;
    }
}

let imageData = null;
let drawTimer = null;
let canvasReady = false;

// Backing-store size requested by the main thread before the OffscreenCanvas
// has been received (message ordering safety).
let pendingSize = null;

self.canvas = null;
self.ctx = null;
self.bufsize = 0;
self.buf = null;

self.columnsPerFrame = 1;

self.rowBins = null;
self.rowBinsFor = 0;

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'data') {
        msg.port.onmessage = (e) => {
            addData(e.data);
        };
        return;
    }

    if (msg.type === 'canvas') {
        self.canvas = msg.canvas;
        self.ctx = self.canvas.getContext('2d');
        if (pendingSize) {
            self.canvas.width = pendingSize.width;
            self.canvas.height = pendingSize.height;
            self.columnsPerFrame = pendingSize.columnsPerFrame || 1;
            pendingSize = null;
        }
        configure();
        return;
    }

    if (msg.type === 'resize') {
        const w = Math.max(1, msg.width | 0);
        const h = Math.max(1, msg.height | 0);
        const cpf = Math.max(1, (msg.columnsPerFrame | 0) || 1);

        if (!self.canvas) {
            pendingSize = { width: w, height: h, columnsPerFrame: cpf };
            return;
        }

        if (self.canvas.width === w && self.canvas.height === h &&
            self.columnsPerFrame === cpf && canvasReady) {
            return;
        }

        self.canvas.width = w;
        self.canvas.height = h;
        self.columnsPerFrame = cpf;
        configure();
        return;
    }

    if (msg.type === 'frame') {
        addData(msg.data);
        return;
    }

    if (msg.type === 'clear') {
        clearSpectrogram();
        return;
    }
});

// (Re)build the image buffer and column history for the current backing-store
// size. Called on first canvas attach and on every resize. bufsize == the
// backing-store width, i.e. one pixel column per incoming spectrum frame, so
// the visible time span = bufsize * hop / sampleRate.
function configure() {
    if (!self.canvas || !self.ctx) return;

    const w = self.canvas.width;
    const h = self.canvas.height;

    imageData = self.ctx.getImageData(0, 0, w, h);
    self.bufsize = Math.max(1, Math.ceil(w / self.columnsPerFrame));
    self.buf = new CircularBuffer(self.bufsize);
    self.rowBins = null;
    self.rowBinsFor = 0;
    canvasReady = true;

    clearImageData();
    self.ctx.putImageData(imageData, 0, 0);

    if (drawTimer) {
        clearTimeout(drawTimer);
        drawTimer = null;
    }

    draw();
}

function clearImageData() {
    if (!imageData) return;
    imageData.data.fill(0);
}

function clearSpectrogram() {
    if (!self.buf) return;

    self.buf.clear();

    if (imageData) {
        clearImageData();
        if (self.ctx) {
            self.ctx.putImageData(imageData, 0, 0);
        }
    }
}

// Store palette indices, not RGB triples: one small typed array per frame
// instead of an array of arrays, and the colour lookup happens once per bin.
function addData(data) {
    if (!canvasReady || !self.buf || !data) return;

    const indices = new Uint16Array(data.length);
    for (let i = 0; i < data.length; ++i) {
        indices[i] = colorIndexOf(data[i]);
    }
    self.buf.push(indices);
}

function draw() {
    if (!canvasReady || !imageData || !self.buf || !self.canvas || !self.ctx) {
        drawTimer = setTimeout(draw, 30);
        return;
    }

    const W = self.canvas.width;
    const H = self.canvas.height;
    const cpf = Math.max(1, self.columnsPerFrame | 0);
    const data = imageData.data;
    data.fill(0);

    const count = self.buf.buffer.length;
    const bins = count > 0 ? (self.buf.get(0) || []).length : 0;

    if (bins > 0) {
        buildRowBins(H, bins);
    }

    const rows = self.rowBins;

    for (let i = 0; i < count && rows; ++i) {
        const c = self.buf.get(i);
        if (!c || c.length !== bins) continue;

        const x0 = i * cpf;
        if (x0 >= W) break;
        const x1 = Math.min(W, x0 + cpf);

        for (let y = 0; y < H; ++y) {
            const lut = c[rows[y]] * 3;
            const r = COLOR_LUT[lut];
            const g = COLOR_LUT[lut + 1];
            const b = COLOR_LUT[lut + 2];

            let idx = (y * W + x0) * 4;
            for (let x = x0; x < x1; ++x, idx += 4) {
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 255;
            }
        }
    }

    self.ctx.putImageData(imageData, 0, 0);
    drawTimer = setTimeout(draw, 30);
}

// Map every canvas row to a frequency bin so the full spectrum is shown
// regardless of canvas height: bottom row = bin 0 (DC), top row = highest bin
// (Nyquist).
function buildRowBins(H, bins) {
    if (self.rowBins && self.rowBins.length === H && self.rowBinsFor === bins) {
        return;
    }

    const rows = new Int32Array(H);
    for (let y = 0; y < H; ++y) {
        let bin = (H > 1)
            ? Math.round(((H - 1 - y) / (H - 1)) * (bins - 1))
            : 0;
        if (bin < 0) bin = 0;
        else if (bin >= bins) bin = bins - 1;
        rows[y] = bin;
    }

    self.rowBins = rows;
    self.rowBinsFor = bins;
}

// The ml worker sends magnitudes normalized so that 1.0 is a full-scale sine,
// whatever frontend gain the model uses. The window below is therefore absolute:
// anything quieter than the floor is black, anything above the ceiling
// saturates. Measured against the bundled speech sample at -28 dBFS RMS, whose
// bins run from about -85 dB (room floor) to -25 dB (formant peaks).
// Deliberately fixed rather than auto-ranging: two panels that scale themselves
// independently cannot be compared, which is the point of the demo.
const SPEC_DB_FLOOR = -90;
const SPEC_DB_CEIL = -25;
const SPEC_DB_SCALE = 1 / (SPEC_DB_CEIL - SPEC_DB_FLOOR);

function colorIndexOf(magnitude) {
    const m = magnitude > 0 ? magnitude : -magnitude;
    const db = 20 * Math.log10(m + 1e-12);
    const t = (db - SPEC_DB_FLOOR) * SPEC_DB_SCALE;

    if (t <= 0) return 0;
    if (t >= 1) return LUT_LAST;
    return (t * LUT_LAST + 0.5) | 0;
}

const plasmaColorScale_512 = [ // Source: https://github.com/kennethmoreland-com/kennethmoreland-com.github.io/blob/master/color-advice/inferno/inferno-table-byte-0512.csv

        {
            scalar: "0.0",
            RGB_r: "0",
            RGB_g: "0",
            RGB_b: "4"
        },
        {
            scalar: "0.0019569471624266144",
            RGB_r: "0",
            RGB_g: "0",
            RGB_b: "4"
        },
        {
            scalar: "0.003913894324853229",
            RGB_r: "1",
            RGB_g: "0",
            RGB_b: "5"
        },
        {
            scalar: "0.005870841487279843",
            RGB_r: "1",
            RGB_g: "0",
            RGB_b: "5"
        },
        {
            scalar: "0.007827788649706457",
            RGB_r: "1",
            RGB_g: "1",
            RGB_b: "6"
        },
        {
            scalar: "0.009784735812133072",
            RGB_r: "1",
            RGB_g: "1",
            RGB_b: "7"
        },
        {
            scalar: "0.011741682974559686",
            RGB_r: "1",
            RGB_g: "1",
            RGB_b: "8"
        },
        {
            scalar: "0.0136986301369863",
            RGB_r: "1",
            RGB_g: "1",
            RGB_b: "9"
        },
        {
            scalar: "0.015655577299412915",
            RGB_r: "2",
            RGB_g: "1",
            RGB_b: "10"
        },
        {
            scalar: "0.01761252446183953",
            RGB_r: "2",
            RGB_g: "1",
            RGB_b: "11"
        },
        {
            scalar: "0.019569471624266144",
            RGB_r: "2",
            RGB_g: "2",
            RGB_b: "12"
        },
        {
            scalar: "0.021526418786692758",
            RGB_r: "2",
            RGB_g: "2",
            RGB_b: "13"
        },
        {
            scalar: "0.023483365949119372",
            RGB_r: "2",
            RGB_g: "2",
            RGB_b: "14"
        },
        {
            scalar: "0.025440313111545987",
            RGB_r: "3",
            RGB_g: "2",
            RGB_b: "15"
        },
        {
            scalar: "0.0273972602739726",
            RGB_r: "3",
            RGB_g: "2",
            RGB_b: "16"
        },
        {
            scalar: "0.029354207436399216",
            RGB_r: "3",
            RGB_g: "3",
            RGB_b: "17"
        },
        {
            scalar: "0.03131115459882583",
            RGB_r: "4",
            RGB_g: "3",
            RGB_b: "18"
        },
        {
            scalar: "0.033268101761252444",
            RGB_r: "4",
            RGB_g: "3",
            RGB_b: "19"
        },
        {
            scalar: "0.03522504892367906",
            RGB_r: "4",
            RGB_g: "3",
            RGB_b: "20"
        },
        {
            scalar: "0.03718199608610567",
            RGB_r: "5",
            RGB_g: "4",
            RGB_b: "22"
        },
        {
            scalar: "0.03913894324853229",
            RGB_r: "5",
            RGB_g: "4",
            RGB_b: "23"
        },
        {
            scalar: "0.0410958904109589",
            RGB_r: "5",
            RGB_g: "4",
            RGB_b: "24"
        },
        {
            scalar: "0.043052837573385516",
            RGB_r: "6",
            RGB_g: "4",
            RGB_b: "25"
        },
        {
            scalar: "0.04500978473581213",
            RGB_r: "6",
            RGB_g: "5",
            RGB_b: "26"
        },
        {
            scalar: "0.046966731898238745",
            RGB_r: "7",
            RGB_g: "5",
            RGB_b: "27"
        },
        {
            scalar: "0.04892367906066536",
            RGB_r: "7",
            RGB_g: "5",
            RGB_b: "28"
        },
        {
            scalar: "0.050880626223091974",
            RGB_r: "7",
            RGB_g: "5",
            RGB_b: "29"
        },
        {
            scalar: "0.05283757338551859",
            RGB_r: "8",
            RGB_g: "6",
            RGB_b: "30"
        },
        {
            scalar: "0.0547945205479452",
            RGB_r: "8",
            RGB_g: "6",
            RGB_b: "31"
        },
        {
            scalar: "0.05675146771037182",
            RGB_r: "9",
            RGB_g: "6",
            RGB_b: "33"
        },
        {
            scalar: "0.05870841487279843",
            RGB_r: "10",
            RGB_g: "7",
            RGB_b: "34"
        },
        {
            scalar: "0.060665362035225046",
            RGB_r: "10",
            RGB_g: "7",
            RGB_b: "35"
        },
        {
            scalar: "0.06262230919765166",
            RGB_r: "11",
            RGB_g: "7",
            RGB_b: "36"
        },
        {
            scalar: "0.06457925636007827",
            RGB_r: "11",
            RGB_g: "7",
            RGB_b: "37"
        },
        {
            scalar: "0.06653620352250489",
            RGB_r: "12",
            RGB_g: "8",
            RGB_b: "38"
        },
        {
            scalar: "0.0684931506849315",
            RGB_r: "13",
            RGB_g: "8",
            RGB_b: "39"
        },
        {
            scalar: "0.07045009784735812",
            RGB_r: "13",
            RGB_g: "8",
            RGB_b: "41"
        },
        {
            scalar: "0.07240704500978473",
            RGB_r: "14",
            RGB_g: "9",
            RGB_b: "42"
        },
        {
            scalar: "0.07436399217221135",
            RGB_r: "14",
            RGB_g: "9",
            RGB_b: "43"
        },
        {
            scalar: "0.07632093933463796",
            RGB_r: "15",
            RGB_g: "9",
            RGB_b: "44"
        },
        {
            scalar: "0.07827788649706457",
            RGB_r: "16",
            RGB_g: "9",
            RGB_b: "45"
        },
        {
            scalar: "0.08023483365949119",
            RGB_r: "16",
            RGB_g: "10",
            RGB_b: "46"
        },
        {
            scalar: "0.0821917808219178",
            RGB_r: "17",
            RGB_g: "10",
            RGB_b: "48"
        },
        {
            scalar: "0.08414872798434442",
            RGB_r: "17",
            RGB_g: "10",
            RGB_b: "49"
        },
        {
            scalar: "0.08610567514677103",
            RGB_r: "18",
            RGB_g: "10",
            RGB_b: "50"
        },
        {
            scalar: "0.08806262230919765",
            RGB_r: "19",
            RGB_g: "10",
            RGB_b: "51"
        },
        {
            scalar: "0.09001956947162426",
            RGB_r: "19",
            RGB_g: "11",
            RGB_b: "52"
        },
        {
            scalar: "0.09197651663405088",
            RGB_r: "20",
            RGB_g: "11",
            RGB_b: "54"
        },
        {
            scalar: "0.09393346379647749",
            RGB_r: "21",
            RGB_g: "11",
            RGB_b: "55"
        },
        {
            scalar: "0.0958904109589041",
            RGB_r: "22",
            RGB_g: "11",
            RGB_b: "56"
        },
        {
            scalar: "0.09784735812133072",
            RGB_r: "22",
            RGB_g: "11",
            RGB_b: "57"
        },
        {
            scalar: "0.09980430528375733",
            RGB_r: "23",
            RGB_g: "11",
            RGB_b: "58"
        },
        {
            scalar: "0.10176125244618395",
            RGB_r: "24",
            RGB_g: "12",
            RGB_b: "60"
        },
        {
            scalar: "0.10371819960861056",
            RGB_r: "24",
            RGB_g: "12",
            RGB_b: "61"
        },
        {
            scalar: "0.10567514677103718",
            RGB_r: "25",
            RGB_g: "12",
            RGB_b: "62"
        },
        {
            scalar: "0.10763209393346379",
            RGB_r: "26",
            RGB_g: "12",
            RGB_b: "63"
        },
        {
            scalar: "0.1095890410958904",
            RGB_r: "27",
            RGB_g: "12",
            RGB_b: "64"
        },
        {
            scalar: "0.11154598825831702",
            RGB_r: "27",
            RGB_g: "12",
            RGB_b: "66"
        },
        {
            scalar: "0.11350293542074363",
            RGB_r: "28",
            RGB_g: "12",
            RGB_b: "67"
        },
        {
            scalar: "0.11545988258317025",
            RGB_r: "29",
            RGB_g: "12",
            RGB_b: "68"
        },
        {
            scalar: "0.11741682974559686",
            RGB_r: "30",
            RGB_g: "12",
            RGB_b: "69"
        },
        {
            scalar: "0.11937377690802348",
            RGB_r: "30",
            RGB_g: "12",
            RGB_b: "70"
        },
        {
            scalar: "0.12133072407045009",
            RGB_r: "31",
            RGB_g: "12",
            RGB_b: "72"
        },
        {
            scalar: "0.1232876712328767",
            RGB_r: "32",
            RGB_g: "12",
            RGB_b: "73"
        },
        {
            scalar: "0.12524461839530332",
            RGB_r: "33",
            RGB_g: "12",
            RGB_b: "74"
        },
        {
            scalar: "0.12720156555772993",
            RGB_r: "34",
            RGB_g: "12",
            RGB_b: "75"
        },
        {
            scalar: "0.12915851272015655",
            RGB_r: "35",
            RGB_g: "12",
            RGB_b: "76"
        },
        {
            scalar: "0.13111545988258316",
            RGB_r: "35",
            RGB_g: "12",
            RGB_b: "77"
        },
        {
            scalar: "0.13307240704500978",
            RGB_r: "36",
            RGB_g: "12",
            RGB_b: "79"
        },
        {
            scalar: "0.1350293542074364",
            RGB_r: "37",
            RGB_g: "12",
            RGB_b: "80"
        },
        {
            scalar: "0.136986301369863",
            RGB_r: "38",
            RGB_g: "12",
            RGB_b: "81"
        },
        {
            scalar: "0.13894324853228962",
            RGB_r: "39",
            RGB_g: "11",
            RGB_b: "82"
        },
        {
            scalar: "0.14090019569471623",
            RGB_r: "40",
            RGB_g: "11",
            RGB_b: "83"
        },
        {
            scalar: "0.14285714285714285",
            RGB_r: "40",
            RGB_g: "11",
            RGB_b: "84"
        },
        {
            scalar: "0.14481409001956946",
            RGB_r: "41",
            RGB_g: "11",
            RGB_b: "85"
        },
        {
            scalar: "0.14677103718199608",
            RGB_r: "42",
            RGB_g: "11",
            RGB_b: "86"
        },
        {
            scalar: "0.1487279843444227",
            RGB_r: "43",
            RGB_g: "11",
            RGB_b: "87"
        },
        {
            scalar: "0.1506849315068493",
            RGB_r: "44",
            RGB_g: "11",
            RGB_b: "88"
        },
        {
            scalar: "0.15264187866927592",
            RGB_r: "45",
            RGB_g: "11",
            RGB_b: "89"
        },
        {
            scalar: "0.15459882583170254",
            RGB_r: "46",
            RGB_g: "10",
            RGB_b: "90"
        },
        {
            scalar: "0.15655577299412915",
            RGB_r: "47",
            RGB_g: "10",
            RGB_b: "90"
        },
        {
            scalar: "0.15851272015655576",
            RGB_r: "48",
            RGB_g: "10",
            RGB_b: "91"
        },
        {
            scalar: "0.16046966731898238",
            RGB_r: "48",
            RGB_g: "10",
            RGB_b: "92"
        },
        {
            scalar: "0.162426614481409",
            RGB_r: "49",
            RGB_g: "10",
            RGB_b: "93"
        },
        {
            scalar: "0.1643835616438356",
            RGB_r: "50",
            RGB_g: "10",
            RGB_b: "94"
        },
        {
            scalar: "0.16634050880626222",
            RGB_r: "51",
            RGB_g: "10",
            RGB_b: "94"
        },
        {
            scalar: "0.16829745596868884",
            RGB_r: "52",
            RGB_g: "10",
            RGB_b: "95"
        },
        {
            scalar: "0.17025440313111545",
            RGB_r: "53",
            RGB_g: "10",
            RGB_b: "96"
        },
        {
            scalar: "0.17221135029354206",
            RGB_r: "54",
            RGB_g: "9",
            RGB_b: "96"
        },
        {
            scalar: "0.17416829745596868",
            RGB_r: "55",
            RGB_g: "9",
            RGB_b: "97"
        },
        {
            scalar: "0.1761252446183953",
            RGB_r: "55",
            RGB_g: "9",
            RGB_b: "98"
        },
        {
            scalar: "0.1780821917808219",
            RGB_r: "56",
            RGB_g: "9",
            RGB_b: "98"
        },
        {
            scalar: "0.18003913894324852",
            RGB_r: "57",
            RGB_g: "9",
            RGB_b: "99"
        },
        {
            scalar: "0.18199608610567514",
            RGB_r: "58",
            RGB_g: "9",
            RGB_b: "99"
        },
        {
            scalar: "0.18395303326810175",
            RGB_r: "59",
            RGB_g: "9",
            RGB_b: "100"
        },
        {
            scalar: "0.18590998043052837",
            RGB_r: "60",
            RGB_g: "9",
            RGB_b: "100"
        },
        {
            scalar: "0.18786692759295498",
            RGB_r: "61",
            RGB_g: "9",
            RGB_b: "101"
        },
        {
            scalar: "0.1898238747553816",
            RGB_r: "61",
            RGB_g: "9",
            RGB_b: "101"
        },
        {
            scalar: "0.1917808219178082",
            RGB_r: "62",
            RGB_g: "9",
            RGB_b: "102"
        },
        {
            scalar: "0.19373776908023482",
            RGB_r: "63",
            RGB_g: "10",
            RGB_b: "102"
        },
        {
            scalar: "0.19569471624266144",
            RGB_r: "64",
            RGB_g: "10",
            RGB_b: "103"
        },
        {
            scalar: "0.19765166340508805",
            RGB_r: "65",
            RGB_g: "10",
            RGB_b: "103"
        },
        {
            scalar: "0.19960861056751467",
            RGB_r: "66",
            RGB_g: "10",
            RGB_b: "104"
        },
        {
            scalar: "0.20156555772994128",
            RGB_r: "67",
            RGB_g: "10",
            RGB_b: "104"
        },
        {
            scalar: "0.2035225048923679",
            RGB_r: "67",
            RGB_g: "10",
            RGB_b: "104"
        },
        {
            scalar: "0.2054794520547945",
            RGB_r: "68",
            RGB_g: "10",
            RGB_b: "105"
        },
        {
            scalar: "0.20743639921722112",
            RGB_r: "69",
            RGB_g: "10",
            RGB_b: "105"
        },
        {
            scalar: "0.20939334637964774",
            RGB_r: "70",
            RGB_g: "11",
            RGB_b: "105"
        },
        {
            scalar: "0.21135029354207435",
            RGB_r: "71",
            RGB_g: "11",
            RGB_b: "106"
        },
        {
            scalar: "0.21330724070450097",
            RGB_r: "72",
            RGB_g: "11",
            RGB_b: "106"
        },
        {
            scalar: "0.21526418786692758",
            RGB_r: "72",
            RGB_g: "11",
            RGB_b: "106"
        },
        {
            scalar: "0.2172211350293542",
            RGB_r: "73",
            RGB_g: "11",
            RGB_b: "106"
        },
        {
            scalar: "0.2191780821917808",
            RGB_r: "74",
            RGB_g: "12",
            RGB_b: "107"
        },
        {
            scalar: "0.22113502935420742",
            RGB_r: "75",
            RGB_g: "12",
            RGB_b: "107"
        },
        {
            scalar: "0.22309197651663404",
            RGB_r: "76",
            RGB_g: "12",
            RGB_b: "107"
        },
        {
            scalar: "0.22504892367906065",
            RGB_r: "76",
            RGB_g: "12",
            RGB_b: "107"
        },
        {
            scalar: "0.22700587084148727",
            RGB_r: "77",
            RGB_g: "13",
            RGB_b: "108"
        },
        {
            scalar: "0.22896281800391388",
            RGB_r: "78",
            RGB_g: "13",
            RGB_b: "108"
        },
        {
            scalar: "0.2309197651663405",
            RGB_r: "79",
            RGB_g: "13",
            RGB_b: "108"
        },
        {
            scalar: "0.2328767123287671",
            RGB_r: "80",
            RGB_g: "13",
            RGB_b: "108"
        },
        {
            scalar: "0.23483365949119372",
            RGB_r: "80",
            RGB_g: "14",
            RGB_b: "108"
        },
        {
            scalar: "0.23679060665362034",
            RGB_r: "81",
            RGB_g: "14",
            RGB_b: "109"
        },
        {
            scalar: "0.23874755381604695",
            RGB_r: "82",
            RGB_g: "14",
            RGB_b: "109"
        },
        {
            scalar: "0.24070450097847357",
            RGB_r: "83",
            RGB_g: "14",
            RGB_b: "109"
        },
        {
            scalar: "0.24266144814090018",
            RGB_r: "84",
            RGB_g: "15",
            RGB_b: "109"
        },
        {
            scalar: "0.2446183953033268",
            RGB_r: "84",
            RGB_g: "15",
            RGB_b: "109"
        },
        {
            scalar: "0.2465753424657534",
            RGB_r: "85",
            RGB_g: "15",
            RGB_b: "109"
        },
        {
            scalar: "0.24853228962818003",
            RGB_r: "86",
            RGB_g: "16",
            RGB_b: "109"
        },
        {
            scalar: "0.25048923679060664",
            RGB_r: "87",
            RGB_g: "16",
            RGB_b: "109"
        },
        {
            scalar: "0.25244618395303325",
            RGB_r: "88",
            RGB_g: "16",
            RGB_b: "110"
        },
        {
            scalar: "0.25440313111545987",
            RGB_r: "88",
            RGB_g: "16",
            RGB_b: "110"
        },
        {
            scalar: "0.2563600782778865",
            RGB_r: "89",
            RGB_g: "17",
            RGB_b: "110"
        },
        {
            scalar: "0.2583170254403131",
            RGB_r: "90",
            RGB_g: "17",
            RGB_b: "110"
        },
        {
            scalar: "0.2602739726027397",
            RGB_r: "91",
            RGB_g: "17",
            RGB_b: "110"
        },
        {
            scalar: "0.2622309197651663",
            RGB_r: "92",
            RGB_g: "18",
            RGB_b: "110"
        },
        {
            scalar: "0.26418786692759294",
            RGB_r: "92",
            RGB_g: "18",
            RGB_b: "110"
        },
        {
            scalar: "0.26614481409001955",
            RGB_r: "93",
            RGB_g: "18",
            RGB_b: "110"
        },
        {
            scalar: "0.26810176125244617",
            RGB_r: "94",
            RGB_g: "18",
            RGB_b: "110"
        },
        {
            scalar: "0.2700587084148728",
            RGB_r: "95",
            RGB_g: "19",
            RGB_b: "110"
        },
        {
            scalar: "0.2720156555772994",
            RGB_r: "96",
            RGB_g: "19",
            RGB_b: "110"
        },
        {
            scalar: "0.273972602739726",
            RGB_r: "96",
            RGB_g: "19",
            RGB_b: "110"
        },
        {
            scalar: "0.2759295499021526",
            RGB_r: "97",
            RGB_g: "20",
            RGB_b: "110"
        },
        {
            scalar: "0.27788649706457924",
            RGB_r: "98",
            RGB_g: "20",
            RGB_b: "110"
        },
        {
            scalar: "0.27984344422700586",
            RGB_r: "99",
            RGB_g: "20",
            RGB_b: "110"
        },
        {
            scalar: "0.28180039138943247",
            RGB_r: "100",
            RGB_g: "21",
            RGB_b: "110"
        },
        {
            scalar: "0.2837573385518591",
            RGB_r: "100",
            RGB_g: "21",
            RGB_b: "110"
        },
        {
            scalar: "0.2857142857142857",
            RGB_r: "101",
            RGB_g: "21",
            RGB_b: "110"
        },
        {
            scalar: "0.2876712328767123",
            RGB_r: "102",
            RGB_g: "21",
            RGB_b: "110"
        },
        {
            scalar: "0.2896281800391389",
            RGB_r: "103",
            RGB_g: "22",
            RGB_b: "110"
        },
        {
            scalar: "0.29158512720156554",
            RGB_r: "104",
            RGB_g: "22",
            RGB_b: "110"
        },
        {
            scalar: "0.29354207436399216",
            RGB_r: "104",
            RGB_g: "22",
            RGB_b: "110"
        },
        {
            scalar: "0.29549902152641877",
            RGB_r: "105",
            RGB_g: "23",
            RGB_b: "110"
        },
        {
            scalar: "0.2974559686888454",
            RGB_r: "106",
            RGB_g: "23",
            RGB_b: "110"
        },
        {
            scalar: "0.299412915851272",
            RGB_r: "107",
            RGB_g: "23",
            RGB_b: "110"
        },
        {
            scalar: "0.3013698630136986",
            RGB_r: "108",
            RGB_g: "23",
            RGB_b: "110"
        },
        {
            scalar: "0.30332681017612523",
            RGB_r: "108",
            RGB_g: "24",
            RGB_b: "110"
        },
        {
            scalar: "0.30528375733855184",
            RGB_r: "109",
            RGB_g: "24",
            RGB_b: "110"
        },
        {
            scalar: "0.30724070450097846",
            RGB_r: "110",
            RGB_g: "24",
            RGB_b: "110"
        },
        {
            scalar: "0.30919765166340507",
            RGB_r: "111",
            RGB_g: "25",
            RGB_b: "110"
        },
        {
            scalar: "0.3111545988258317",
            RGB_r: "111",
            RGB_g: "25",
            RGB_b: "110"
        },
        {
            scalar: "0.3131115459882583",
            RGB_r: "112",
            RGB_g: "25",
            RGB_b: "110"
        },
        {
            scalar: "0.3150684931506849",
            RGB_r: "113",
            RGB_g: "26",
            RGB_b: "110"
        },
        {
            scalar: "0.31702544031311153",
            RGB_r: "114",
            RGB_g: "26",
            RGB_b: "110"
        },
        {
            scalar: "0.31898238747553814",
            RGB_r: "115",
            RGB_g: "26",
            RGB_b: "110"
        },
        {
            scalar: "0.32093933463796476",
            RGB_r: "115",
            RGB_g: "26",
            RGB_b: "110"
        },
        {
            scalar: "0.32289628180039137",
            RGB_r: "116",
            RGB_g: "27",
            RGB_b: "110"
        },
        {
            scalar: "0.324853228962818",
            RGB_r: "117",
            RGB_g: "27",
            RGB_b: "110"
        },
        {
            scalar: "0.3268101761252446",
            RGB_r: "118",
            RGB_g: "27",
            RGB_b: "110"
        },
        {
            scalar: "0.3287671232876712",
            RGB_r: "119",
            RGB_g: "28",
            RGB_b: "109"
        },
        {
            scalar: "0.33072407045009783",
            RGB_r: "119",
            RGB_g: "28",
            RGB_b: "109"
        },
        {
            scalar: "0.33268101761252444",
            RGB_r: "120",
            RGB_g: "28",
            RGB_b: "109"
        },
        {
            scalar: "0.33463796477495106",
            RGB_r: "121",
            RGB_g: "28",
            RGB_b: "109"
        },
        {
            scalar: "0.33659491193737767",
            RGB_r: "122",
            RGB_g: "29",
            RGB_b: "109"
        },
        {
            scalar: "0.3385518590998043",
            RGB_r: "123",
            RGB_g: "29",
            RGB_b: "109"
        },
        {
            scalar: "0.3405088062622309",
            RGB_r: "123",
            RGB_g: "29",
            RGB_b: "109"
        },
        {
            scalar: "0.3424657534246575",
            RGB_r: "124",
            RGB_g: "30",
            RGB_b: "109"
        },
        {
            scalar: "0.34442270058708413",
            RGB_r: "125",
            RGB_g: "30",
            RGB_b: "109"
        },
        {
            scalar: "0.34637964774951074",
            RGB_r: "126",
            RGB_g: "30",
            RGB_b: "108"
        },
        {
            scalar: "0.34833659491193736",
            RGB_r: "127",
            RGB_g: "30",
            RGB_b: "108"
        },
        {
            scalar: "0.350293542074364",
            RGB_r: "127",
            RGB_g: "31",
            RGB_b: "108"
        },
        {
            scalar: "0.3522504892367906",
            RGB_r: "128",
            RGB_g: "31",
            RGB_b: "108"
        },
        {
            scalar: "0.3542074363992172",
            RGB_r: "129",
            RGB_g: "31",
            RGB_b: "108"
        },
        {
            scalar: "0.3561643835616438",
            RGB_r: "130",
            RGB_g: "31",
            RGB_b: "108"
        },
        {
            scalar: "0.35812133072407043",
            RGB_r: "130",
            RGB_g: "32",
            RGB_b: "108"
        },
        {
            scalar: "0.36007827788649704",
            RGB_r: "131",
            RGB_g: "32",
            RGB_b: "107"
        },
        {
            scalar: "0.36203522504892366",
            RGB_r: "132",
            RGB_g: "32",
            RGB_b: "107"
        },
        {
            scalar: "0.3639921722113503",
            RGB_r: "133",
            RGB_g: "33",
            RGB_b: "107"
        },
        {
            scalar: "0.3659491193737769",
            RGB_r: "134",
            RGB_g: "33",
            RGB_b: "107"
        },
        {
            scalar: "0.3679060665362035",
            RGB_r: "134",
            RGB_g: "33",
            RGB_b: "107"
        },
        {
            scalar: "0.3698630136986301",
            RGB_r: "135",
            RGB_g: "33",
            RGB_b: "107"
        },
        {
            scalar: "0.37181996086105673",
            RGB_r: "136",
            RGB_g: "34",
            RGB_b: "106"
        },
        {
            scalar: "0.37377690802348335",
            RGB_r: "137",
            RGB_g: "34",
            RGB_b: "106"
        },
        {
            scalar: "0.37573385518590996",
            RGB_r: "138",
            RGB_g: "34",
            RGB_b: "106"
        },
        {
            scalar: "0.3776908023483366",
            RGB_r: "138",
            RGB_g: "35",
            RGB_b: "106"
        },
        {
            scalar: "0.3796477495107632",
            RGB_r: "139",
            RGB_g: "35",
            RGB_b: "106"
        },
        {
            scalar: "0.3816046966731898",
            RGB_r: "140",
            RGB_g: "35",
            RGB_b: "105"
        },
        {
            scalar: "0.3835616438356164",
            RGB_r: "141",
            RGB_g: "35",
            RGB_b: "105"
        },
        {
            scalar: "0.38551859099804303",
            RGB_r: "142",
            RGB_g: "36",
            RGB_b: "105"
        },
        {
            scalar: "0.38747553816046965",
            RGB_r: "142",
            RGB_g: "36",
            RGB_b: "105"
        },
        {
            scalar: "0.38943248532289626",
            RGB_r: "143",
            RGB_g: "36",
            RGB_b: "104"
        },
        {
            scalar: "0.3913894324853229",
            RGB_r: "144",
            RGB_g: "36",
            RGB_b: "104"
        },
        {
            scalar: "0.3933463796477495",
            RGB_r: "145",
            RGB_g: "37",
            RGB_b: "104"
        },
        {
            scalar: "0.3953033268101761",
            RGB_r: "146",
            RGB_g: "37",
            RGB_b: "104"
        },
        {
            scalar: "0.3972602739726027",
            RGB_r: "146",
            RGB_g: "37",
            RGB_b: "103"
        },
        {
            scalar: "0.39921722113502933",
            RGB_r: "147",
            RGB_g: "38",
            RGB_b: "103"
        },
        {
            scalar: "0.40117416829745595",
            RGB_r: "148",
            RGB_g: "38",
            RGB_b: "103"
        },
        {
            scalar: "0.40313111545988256",
            RGB_r: "149",
            RGB_g: "38",
            RGB_b: "103"
        },
        {
            scalar: "0.4050880626223092",
            RGB_r: "150",
            RGB_g: "38",
            RGB_b: "102"
        },
        {
            scalar: "0.4070450097847358",
            RGB_r: "150",
            RGB_g: "39",
            RGB_b: "102"
        },
        {
            scalar: "0.4090019569471624",
            RGB_r: "151",
            RGB_g: "39",
            RGB_b: "102"
        },
        {
            scalar: "0.410958904109589",
            RGB_r: "152",
            RGB_g: "39",
            RGB_b: "102"
        },
        {
            scalar: "0.41291585127201563",
            RGB_r: "153",
            RGB_g: "40",
            RGB_b: "101"
        },
        {
            scalar: "0.41487279843444225",
            RGB_r: "153",
            RGB_g: "40",
            RGB_b: "101"
        },
        {
            scalar: "0.41682974559686886",
            RGB_r: "154",
            RGB_g: "40",
            RGB_b: "101"
        },
        {
            scalar: "0.4187866927592955",
            RGB_r: "155",
            RGB_g: "41",
            RGB_b: "100"
        },
        {
            scalar: "0.4207436399217221",
            RGB_r: "156",
            RGB_g: "41",
            RGB_b: "100"
        },
        {
            scalar: "0.4227005870841487",
            RGB_r: "157",
            RGB_g: "41",
            RGB_b: "100"
        },
        {
            scalar: "0.4246575342465753",
            RGB_r: "157",
            RGB_g: "41",
            RGB_b: "100"
        },
        {
            scalar: "0.42661448140900193",
            RGB_r: "158",
            RGB_g: "42",
            RGB_b: "99"
        },
        {
            scalar: "0.42857142857142855",
            RGB_r: "159",
            RGB_g: "42",
            RGB_b: "99"
        },
        {
            scalar: "0.43052837573385516",
            RGB_r: "160",
            RGB_g: "42",
            RGB_b: "99"
        },
        {
            scalar: "0.4324853228962818",
            RGB_r: "161",
            RGB_g: "43",
            RGB_b: "98"
        },
        {
            scalar: "0.4344422700587084",
            RGB_r: "161",
            RGB_g: "43",
            RGB_b: "98"
        },
        {
            scalar: "0.436399217221135",
            RGB_r: "162",
            RGB_g: "43",
            RGB_b: "98"
        },
        {
            scalar: "0.4383561643835616",
            RGB_r: "163",
            RGB_g: "44",
            RGB_b: "97"
        },
        {
            scalar: "0.44031311154598823",
            RGB_r: "164",
            RGB_g: "44",
            RGB_b: "97"
        },
        {
            scalar: "0.44227005870841485",
            RGB_r: "164",
            RGB_g: "44",
            RGB_b: "97"
        },
        {
            scalar: "0.44422700587084146",
            RGB_r: "165",
            RGB_g: "45",
            RGB_b: "96"
        },
        {
            scalar: "0.4461839530332681",
            RGB_r: "166",
            RGB_g: "45",
            RGB_b: "96"
        },
        {
            scalar: "0.4481409001956947",
            RGB_r: "167",
            RGB_g: "45",
            RGB_b: "96"
        },
        {
            scalar: "0.4500978473581213",
            RGB_r: "168",
            RGB_g: "45",
            RGB_b: "95"
        },
        {
            scalar: "0.4520547945205479",
            RGB_r: "168",
            RGB_g: "46",
            RGB_b: "95"
        },
        {
            scalar: "0.45401174168297453",
            RGB_r: "169",
            RGB_g: "46",
            RGB_b: "94"
        },
        {
            scalar: "0.45596868884540115",
            RGB_r: "170",
            RGB_g: "46",
            RGB_b: "94"
        },
        {
            scalar: "0.45792563600782776",
            RGB_r: "171",
            RGB_g: "47",
            RGB_b: "94"
        },
        {
            scalar: "0.4598825831702544",
            RGB_r: "171",
            RGB_g: "47",
            RGB_b: "93"
        },
        {
            scalar: "0.461839530332681",
            RGB_r: "172",
            RGB_g: "47",
            RGB_b: "93"
        },
        {
            scalar: "0.4637964774951076",
            RGB_r: "173",
            RGB_g: "48",
            RGB_b: "93"
        },
        {
            scalar: "0.4657534246575342",
            RGB_r: "174",
            RGB_g: "48",
            RGB_b: "92"
        },
        {
            scalar: "0.46771037181996084",
            RGB_r: "174",
            RGB_g: "49",
            RGB_b: "92"
        },
        {
            scalar: "0.46966731898238745",
            RGB_r: "175",
            RGB_g: "49",
            RGB_b: "91"
        },
        {
            scalar: "0.47162426614481406",
            RGB_r: "176",
            RGB_g: "49",
            RGB_b: "91"
        },
        {
            scalar: "0.4735812133072407",
            RGB_r: "177",
            RGB_g: "50",
            RGB_b: "91"
        },
        {
            scalar: "0.4755381604696673",
            RGB_r: "178",
            RGB_g: "50",
            RGB_b: "90"
        },
        {
            scalar: "0.4774951076320939",
            RGB_r: "178",
            RGB_g: "50",
            RGB_b: "90"
        },
        {
            scalar: "0.4794520547945205",
            RGB_r: "179",
            RGB_g: "51",
            RGB_b: "89"
        },
        {
            scalar: "0.48140900195694714",
            RGB_r: "180",
            RGB_g: "51",
            RGB_b: "89"
        },
        {
            scalar: "0.48336594911937375",
            RGB_r: "181",
            RGB_g: "51",
            RGB_b: "88"
        },
        {
            scalar: "0.48532289628180036",
            RGB_r: "181",
            RGB_g: "52",
            RGB_b: "88"
        },
        {
            scalar: "0.487279843444227",
            RGB_r: "182",
            RGB_g: "52",
            RGB_b: "88"
        },
        {
            scalar: "0.4892367906066536",
            RGB_r: "183",
            RGB_g: "53",
            RGB_b: "87"
        },
        {
            scalar: "0.4911937377690802",
            RGB_r: "184",
            RGB_g: "53",
            RGB_b: "87"
        },
        {
            scalar: "0.4931506849315068",
            RGB_r: "184",
            RGB_g: "53",
            RGB_b: "86"
        },
        {
            scalar: "0.49510763209393344",
            RGB_r: "185",
            RGB_g: "54",
            RGB_b: "86"
        },
        {
            scalar: "0.49706457925636005",
            RGB_r: "186",
            RGB_g: "54",
            RGB_b: "85"
        },
        {
            scalar: "0.49902152641878667",
            RGB_r: "186",
            RGB_g: "54",
            RGB_b: "85"
        },
        {
            scalar: "0.5009784735812133",
            RGB_r: "187",
            RGB_g: "55",
            RGB_b: "84"
        },
        {
            scalar: "0.5029354207436398",
            RGB_r: "188",
            RGB_g: "55",
            RGB_b: "84"
        },
        {
            scalar: "0.5048923679060665",
            RGB_r: "189",
            RGB_g: "56",
            RGB_b: "84"
        },
        {
            scalar: "0.5068493150684932",
            RGB_r: "189",
            RGB_g: "56",
            RGB_b: "83"
        },
        {
            scalar: "0.5088062622309197",
            RGB_r: "190",
            RGB_g: "56",
            RGB_b: "83"
        },
        {
            scalar: "0.5107632093933463",
            RGB_r: "191",
            RGB_g: "57",
            RGB_b: "82"
        },
        {
            scalar: "0.512720156555773",
            RGB_r: "192",
            RGB_g: "57",
            RGB_b: "82"
        },
        {
            scalar: "0.5146771037181996",
            RGB_r: "192",
            RGB_g: "58",
            RGB_b: "81"
        },
        {
            scalar: "0.5166340508806262",
            RGB_r: "193",
            RGB_g: "58",
            RGB_b: "81"
        },
        {
            scalar: "0.5185909980430528",
            RGB_r: "194",
            RGB_g: "59",
            RGB_b: "80"
        },
        {
            scalar: "0.5205479452054794",
            RGB_r: "194",
            RGB_g: "59",
            RGB_b: "80"
        },
        {
            scalar: "0.5225048923679061",
            RGB_r: "195",
            RGB_g: "60",
            RGB_b: "79"
        },
        {
            scalar: "0.5244618395303327",
            RGB_r: "196",
            RGB_g: "60",
            RGB_b: "79"
        },
        {
            scalar: "0.5264187866927592",
            RGB_r: "197",
            RGB_g: "60",
            RGB_b: "78"
        },
        {
            scalar: "0.5283757338551859",
            RGB_r: "197",
            RGB_g: "61",
            RGB_b: "78"
        },
        {
            scalar: "0.5303326810176126",
            RGB_r: "198",
            RGB_g: "61",
            RGB_b: "77"
        },
        {
            scalar: "0.5322896281800391",
            RGB_r: "199",
            RGB_g: "62",
            RGB_b: "77"
        },
        {
            scalar: "0.5342465753424657",
            RGB_r: "199",
            RGB_g: "62",
            RGB_b: "76"
        },
        {
            scalar: "0.5362035225048923",
            RGB_r: "200",
            RGB_g: "63",
            RGB_b: "76"
        },
        {
            scalar: "0.538160469667319",
            RGB_r: "201",
            RGB_g: "63",
            RGB_b: "75"
        },
        {
            scalar: "0.5401174168297456",
            RGB_r: "201",
            RGB_g: "64",
            RGB_b: "75"
        },
        {
            scalar: "0.5420743639921721",
            RGB_r: "202",
            RGB_g: "64",
            RGB_b: "74"
        },
        {
            scalar: "0.5440313111545988",
            RGB_r: "203",
            RGB_g: "65",
            RGB_b: "74"
        },
        {
            scalar: "0.5459882583170255",
            RGB_r: "203",
            RGB_g: "65",
            RGB_b: "73"
        },
        {
            scalar: "0.547945205479452",
            RGB_r: "204",
            RGB_g: "66",
            RGB_b: "72"
        },
        {
            scalar: "0.5499021526418786",
            RGB_r: "205",
            RGB_g: "66",
            RGB_b: "72"
        },
        {
            scalar: "0.5518590998043053",
            RGB_r: "205",
            RGB_g: "67",
            RGB_b: "71"
        },
        {
            scalar: "0.5538160469667319",
            RGB_r: "206",
            RGB_g: "67",
            RGB_b: "71"
        },
        {
            scalar: "0.5557729941291585",
            RGB_r: "207",
            RGB_g: "68",
            RGB_b: "70"
        },
        {
            scalar: "0.557729941291585",
            RGB_r: "207",
            RGB_g: "68",
            RGB_b: "70"
        },
        {
            scalar: "0.5596868884540117",
            RGB_r: "208",
            RGB_g: "69",
            RGB_b: "69"
        },
        {
            scalar: "0.5616438356164384",
            RGB_r: "209",
            RGB_g: "69",
            RGB_b: "69"
        },
        {
            scalar: "0.5636007827788649",
            RGB_r: "209",
            RGB_g: "70",
            RGB_b: "68"
        },
        {
            scalar: "0.5655577299412915",
            RGB_r: "210",
            RGB_g: "70",
            RGB_b: "68"
        },
        {
            scalar: "0.5675146771037182",
            RGB_r: "211",
            RGB_g: "71",
            RGB_b: "67"
        },
        {
            scalar: "0.5694716242661448",
            RGB_r: "211",
            RGB_g: "72",
            RGB_b: "67"
        },
        {
            scalar: "0.5714285714285714",
            RGB_r: "212",
            RGB_g: "72",
            RGB_b: "66"
        },
        {
            scalar: "0.573385518590998",
            RGB_r: "213",
            RGB_g: "73",
            RGB_b: "65"
        },
        {
            scalar: "0.5753424657534246",
            RGB_r: "213",
            RGB_g: "73",
            RGB_b: "65"
        },
        {
            scalar: "0.5772994129158513",
            RGB_r: "214",
            RGB_g: "74",
            RGB_b: "64"
        },
        {
            scalar: "0.5792563600782779",
            RGB_r: "214",
            RGB_g: "74",
            RGB_b: "64"
        },
        {
            scalar: "0.5812133072407044",
            RGB_r: "215",
            RGB_g: "75",
            RGB_b: "63"
        },
        {
            scalar: "0.5831702544031311",
            RGB_r: "216",
            RGB_g: "76",
            RGB_b: "63"
        },
        {
            scalar: "0.5851272015655578",
            RGB_r: "216",
            RGB_g: "76",
            RGB_b: "62"
        },
        {
            scalar: "0.5870841487279843",
            RGB_r: "217",
            RGB_g: "77",
            RGB_b: "61"
        },
        {
            scalar: "0.5890410958904109",
            RGB_r: "217",
            RGB_g: "77",
            RGB_b: "61"
        },
        {
            scalar: "0.5909980430528375",
            RGB_r: "218",
            RGB_g: "78",
            RGB_b: "60"
        },
        {
            scalar: "0.5929549902152642",
            RGB_r: "219",
            RGB_g: "79",
            RGB_b: "60"
        },
        {
            scalar: "0.5949119373776908",
            RGB_r: "219",
            RGB_g: "79",
            RGB_b: "59"
        },
        {
            scalar: "0.5968688845401173",
            RGB_r: "220",
            RGB_g: "80",
            RGB_b: "59"
        },
        {
            scalar: "0.598825831702544",
            RGB_r: "220",
            RGB_g: "80",
            RGB_b: "58"
        },
        {
            scalar: "0.6007827788649707",
            RGB_r: "221",
            RGB_g: "81",
            RGB_b: "57"
        },
        {
            scalar: "0.6027397260273972",
            RGB_r: "221",
            RGB_g: "82",
            RGB_b: "57"
        },
        {
            scalar: "0.6046966731898238",
            RGB_r: "222",
            RGB_g: "82",
            RGB_b: "56"
        },
        {
            scalar: "0.6066536203522505",
            RGB_r: "222",
            RGB_g: "83",
            RGB_b: "56"
        },
        {
            scalar: "0.6086105675146771",
            RGB_r: "223",
            RGB_g: "84",
            RGB_b: "55"
        },
        {
            scalar: "0.6105675146771037",
            RGB_r: "224",
            RGB_g: "84",
            RGB_b: "54"
        },
        {
            scalar: "0.6125244618395302",
            RGB_r: "224",
            RGB_g: "85",
            RGB_b: "54"
        },
        {
            scalar: "0.6144814090019569",
            RGB_r: "225",
            RGB_g: "86",
            RGB_b: "53"
        },
        {
            scalar: "0.6164383561643836",
            RGB_r: "225",
            RGB_g: "86",
            RGB_b: "53"
        },
        {
            scalar: "0.6183953033268101",
            RGB_r: "226",
            RGB_g: "87",
            RGB_b: "52"
        },
        {
            scalar: "0.6203522504892367",
            RGB_r: "226",
            RGB_g: "88",
            RGB_b: "52"
        },
        {
            scalar: "0.6223091976516634",
            RGB_r: "227",
            RGB_g: "88",
            RGB_b: "51"
        },
        {
            scalar: "0.62426614481409",
            RGB_r: "227",
            RGB_g: "89",
            RGB_b: "50"
        },
        {
            scalar: "0.6262230919765166",
            RGB_r: "228",
            RGB_g: "90",
            RGB_b: "50"
        },
        {
            scalar: "0.6281800391389432",
            RGB_r: "228",
            RGB_g: "90",
            RGB_b: "49"
        },
        {
            scalar: "0.6301369863013698",
            RGB_r: "229",
            RGB_g: "91",
            RGB_b: "49"
        },
        {
            scalar: "0.6320939334637965",
            RGB_r: "229",
            RGB_g: "92",
            RGB_b: "48"
        },
        {
            scalar: "0.6340508806262231",
            RGB_r: "230",
            RGB_g: "92",
            RGB_b: "47"
        },
        {
            scalar: "0.6360078277886496",
            RGB_r: "230",
            RGB_g: "93",
            RGB_b: "47"
        },
        {
            scalar: "0.6379647749510763",
            RGB_r: "231",
            RGB_g: "94",
            RGB_b: "46"
        },
        {
            scalar: "0.639921722113503",
            RGB_r: "231",
            RGB_g: "95",
            RGB_b: "46"
        },
        {
            scalar: "0.6418786692759295",
            RGB_r: "232",
            RGB_g: "95",
            RGB_b: "45"
        },
        {
            scalar: "0.6438356164383561",
            RGB_r: "232",
            RGB_g: "96",
            RGB_b: "44"
        },
        {
            scalar: "0.6457925636007827",
            RGB_r: "233",
            RGB_g: "97",
            RGB_b: "44"
        },
        {
            scalar: "0.6477495107632094",
            RGB_r: "233",
            RGB_g: "98",
            RGB_b: "43"
        },
        {
            scalar: "0.649706457925636",
            RGB_r: "233",
            RGB_g: "98",
            RGB_b: "42"
        },
        {
            scalar: "0.6516634050880625",
            RGB_r: "234",
            RGB_g: "99",
            RGB_b: "42"
        },
        {
            scalar: "0.6536203522504892",
            RGB_r: "234",
            RGB_g: "100",
            RGB_b: "41"
        },
        {
            scalar: "0.6555772994129159",
            RGB_r: "235",
            RGB_g: "101",
            RGB_b: "41"
        },
        {
            scalar: "0.6575342465753424",
            RGB_r: "235",
            RGB_g: "101",
            RGB_b: "40"
        },
        {
            scalar: "0.659491193737769",
            RGB_r: "236",
            RGB_g: "102",
            RGB_b: "39"
        },
        {
            scalar: "0.6614481409001957",
            RGB_r: "236",
            RGB_g: "103",
            RGB_b: "39"
        },
        {
            scalar: "0.6634050880626223",
            RGB_r: "236",
            RGB_g: "104",
            RGB_b: "38"
        },
        {
            scalar: "0.6653620352250489",
            RGB_r: "237",
            RGB_g: "104",
            RGB_b: "37"
        },
        {
            scalar: "0.6673189823874754",
            RGB_r: "237",
            RGB_g: "105",
            RGB_b: "37"
        },
        {
            scalar: "0.6692759295499021",
            RGB_r: "238",
            RGB_g: "106",
            RGB_b: "36"
        },
        {
            scalar: "0.6712328767123288",
            RGB_r: "238",
            RGB_g: "107",
            RGB_b: "36"
        },
        {
            scalar: "0.6731898238747553",
            RGB_r: "238",
            RGB_g: "108",
            RGB_b: "35"
        },
        {
            scalar: "0.6751467710371819",
            RGB_r: "239",
            RGB_g: "108",
            RGB_b: "34"
        },
        {
            scalar: "0.6771037181996086",
            RGB_r: "239",
            RGB_g: "109",
            RGB_b: "34"
        },
        {
            scalar: "0.6790606653620352",
            RGB_r: "239",
            RGB_g: "110",
            RGB_b: "33"
        },
        {
            scalar: "0.6810176125244618",
            RGB_r: "240",
            RGB_g: "111",
            RGB_b: "32"
        },
        {
            scalar: "0.6829745596868884",
            RGB_r: "240",
            RGB_g: "112",
            RGB_b: "32"
        },
        {
            scalar: "0.684931506849315",
            RGB_r: "241",
            RGB_g: "112",
            RGB_b: "31"
        },
        {
            scalar: "0.6868884540117417",
            RGB_r: "241",
            RGB_g: "113",
            RGB_b: "30"
        },
        {
            scalar: "0.6888454011741683",
            RGB_r: "241",
            RGB_g: "114",
            RGB_b: "30"
        },
        {
            scalar: "0.6908023483365948",
            RGB_r: "242",
            RGB_g: "115",
            RGB_b: "29"
        },
        {
            scalar: "0.6927592954990215",
            RGB_r: "242",
            RGB_g: "116",
            RGB_b: "29"
        },
        {
            scalar: "0.6947162426614482",
            RGB_r: "242",
            RGB_g: "116",
            RGB_b: "28"
        },
        {
            scalar: "0.6966731898238747",
            RGB_r: "243",
            RGB_g: "117",
            RGB_b: "27"
        },
        {
            scalar: "0.6986301369863013",
            RGB_r: "243",
            RGB_g: "118",
            RGB_b: "27"
        },
        {
            scalar: "0.700587084148728",
            RGB_r: "243",
            RGB_g: "119",
            RGB_b: "26"
        },
        {
            scalar: "0.7025440313111546",
            RGB_r: "243",
            RGB_g: "120",
            RGB_b: "25"
        },
        {
            scalar: "0.7045009784735812",
            RGB_r: "244",
            RGB_g: "121",
            RGB_b: "25"
        },
        {
            scalar: "0.7064579256360077",
            RGB_r: "244",
            RGB_g: "121",
            RGB_b: "24"
        },
        {
            scalar: "0.7084148727984344",
            RGB_r: "244",
            RGB_g: "122",
            RGB_b: "23"
        },
        {
            scalar: "0.7103718199608611",
            RGB_r: "245",
            RGB_g: "123",
            RGB_b: "23"
        },
        {
            scalar: "0.7123287671232876",
            RGB_r: "245",
            RGB_g: "124",
            RGB_b: "22"
        },
        {
            scalar: "0.7142857142857142",
            RGB_r: "245",
            RGB_g: "125",
            RGB_b: "21"
        },
        {
            scalar: "0.7162426614481409",
            RGB_r: "245",
            RGB_g: "126",
            RGB_b: "21"
        },
        {
            scalar: "0.7181996086105675",
            RGB_r: "246",
            RGB_g: "127",
            RGB_b: "20"
        },
        {
            scalar: "0.7201565557729941",
            RGB_r: "246",
            RGB_g: "127",
            RGB_b: "19"
        },
        {
            scalar: "0.7221135029354206",
            RGB_r: "246",
            RGB_g: "128",
            RGB_b: "19"
        },
        {
            scalar: "0.7240704500978473",
            RGB_r: "246",
            RGB_g: "129",
            RGB_b: "18"
        },
        {
            scalar: "0.726027397260274",
            RGB_r: "247",
            RGB_g: "130",
            RGB_b: "17"
        },
        {
            scalar: "0.7279843444227005",
            RGB_r: "247",
            RGB_g: "131",
            RGB_b: "17"
        },
        {
            scalar: "0.7299412915851271",
            RGB_r: "247",
            RGB_g: "132",
            RGB_b: "16"
        },
        {
            scalar: "0.7318982387475538",
            RGB_r: "247",
            RGB_g: "133",
            RGB_b: "15"
        },
        {
            scalar: "0.7338551859099804",
            RGB_r: "248",
            RGB_g: "134",
            RGB_b: "15"
        },
        {
            scalar: "0.735812133072407",
            RGB_r: "248",
            RGB_g: "134",
            RGB_b: "14"
        },
        {
            scalar: "0.7377690802348336",
            RGB_r: "248",
            RGB_g: "135",
            RGB_b: "13"
        },
        {
            scalar: "0.7397260273972602",
            RGB_r: "248",
            RGB_g: "136",
            RGB_b: "13"
        },
        {
            scalar: "0.7416829745596869",
            RGB_r: "248",
            RGB_g: "137",
            RGB_b: "12"
        },
        {
            scalar: "0.7436399217221135",
            RGB_r: "249",
            RGB_g: "138",
            RGB_b: "12"
        },
        {
            scalar: "0.74559686888454",
            RGB_r: "249",
            RGB_g: "139",
            RGB_b: "11"
        },
        {
            scalar: "0.7475538160469667",
            RGB_r: "249",
            RGB_g: "140",
            RGB_b: "10"
        },
        {
            scalar: "0.7495107632093934",
            RGB_r: "249",
            RGB_g: "141",
            RGB_b: "10"
        },
        {
            scalar: "0.7514677103718199",
            RGB_r: "249",
            RGB_g: "142",
            RGB_b: "9"
        },
        {
            scalar: "0.7534246575342465",
            RGB_r: "250",
            RGB_g: "142",
            RGB_b: "9"
        },
        {
            scalar: "0.7553816046966731",
            RGB_r: "250",
            RGB_g: "143",
            RGB_b: "8"
        },
        {
            scalar: "0.7573385518590998",
            RGB_r: "250",
            RGB_g: "144",
            RGB_b: "8"
        },
        {
            scalar: "0.7592954990215264",
            RGB_r: "250",
            RGB_g: "145",
            RGB_b: "8"
        },
        {
            scalar: "0.7612524461839529",
            RGB_r: "250",
            RGB_g: "146",
            RGB_b: "7"
        },
        {
            scalar: "0.7632093933463796",
            RGB_r: "250",
            RGB_g: "147",
            RGB_b: "7"
        },
        {
            scalar: "0.7651663405088063",
            RGB_r: "250",
            RGB_g: "148",
            RGB_b: "7"
        },
        {
            scalar: "0.7671232876712328",
            RGB_r: "251",
            RGB_g: "149",
            RGB_b: "6"
        },
        {
            scalar: "0.7690802348336594",
            RGB_r: "251",
            RGB_g: "150",
            RGB_b: "6"
        },
        {
            scalar: "0.7710371819960861",
            RGB_r: "251",
            RGB_g: "151",
            RGB_b: "6"
        },
        {
            scalar: "0.7729941291585127",
            RGB_r: "251",
            RGB_g: "152",
            RGB_b: "6"
        },
        {
            scalar: "0.7749510763209393",
            RGB_r: "251",
            RGB_g: "153",
            RGB_b: "6"
        },
        {
            scalar: "0.7769080234833659",
            RGB_r: "251",
            RGB_g: "153",
            RGB_b: "6"
        },
        {
            scalar: "0.7788649706457925",
            RGB_r: "251",
            RGB_g: "154",
            RGB_b: "6"
        },
        {
            scalar: "0.7808219178082192",
            RGB_r: "251",
            RGB_g: "155",
            RGB_b: "6"
        },
        {
            scalar: "0.7827788649706457",
            RGB_r: "251",
            RGB_g: "156",
            RGB_b: "6"
        },
        {
            scalar: "0.7847358121330723",
            RGB_r: "251",
            RGB_g: "157",
            RGB_b: "7"
        },
        {
            scalar: "0.786692759295499",
            RGB_r: "252",
            RGB_g: "158",
            RGB_b: "7"
        },
        {
            scalar: "0.7886497064579256",
            RGB_r: "252",
            RGB_g: "159",
            RGB_b: "7"
        },
        {
            scalar: "0.7906066536203522",
            RGB_r: "252",
            RGB_g: "160",
            RGB_b: "8"
        },
        {
            scalar: "0.7925636007827788",
            RGB_r: "252",
            RGB_g: "161",
            RGB_b: "8"
        },
        {
            scalar: "0.7945205479452054",
            RGB_r: "252",
            RGB_g: "162",
            RGB_b: "8"
        },
        {
            scalar: "0.7964774951076321",
            RGB_r: "252",
            RGB_g: "163",
            RGB_b: "9"
        },
        {
            scalar: "0.7984344422700587",
            RGB_r: "252",
            RGB_g: "164",
            RGB_b: "10"
        },
        {
            scalar: "0.8003913894324852",
            RGB_r: "252",
            RGB_g: "165",
            RGB_b: "10"
        },
        {
            scalar: "0.8023483365949119",
            RGB_r: "252",
            RGB_g: "166",
            RGB_b: "11"
        },
        {
            scalar: "0.8043052837573386",
            RGB_r: "252",
            RGB_g: "167",
            RGB_b: "12"
        },
        {
            scalar: "0.8062622309197651",
            RGB_r: "252",
            RGB_g: "168",
            RGB_b: "13"
        },
        {
            scalar: "0.8082191780821917",
            RGB_r: "252",
            RGB_g: "169",
            RGB_b: "13"
        },
        {
            scalar: "0.8101761252446184",
            RGB_r: "252",
            RGB_g: "170",
            RGB_b: "14"
        },
        {
            scalar: "0.812133072407045",
            RGB_r: "252",
            RGB_g: "170",
            RGB_b: "15"
        },
        {
            scalar: "0.8140900195694716",
            RGB_r: "252",
            RGB_g: "171",
            RGB_b: "16"
        },
        {
            scalar: "0.8160469667318981",
            RGB_r: "252",
            RGB_g: "172",
            RGB_b: "17"
        },
        {
            scalar: "0.8180039138943248",
            RGB_r: "252",
            RGB_g: "173",
            RGB_b: "18"
        },
        {
            scalar: "0.8199608610567515",
            RGB_r: "252",
            RGB_g: "174",
            RGB_b: "19"
        },
        {
            scalar: "0.821917808219178",
            RGB_r: "252",
            RGB_g: "175",
            RGB_b: "20"
        },
        {
            scalar: "0.8238747553816046",
            RGB_r: "252",
            RGB_g: "176",
            RGB_b: "21"
        },
        {
            scalar: "0.8258317025440313",
            RGB_r: "252",
            RGB_g: "177",
            RGB_b: "22"
        },
        {
            scalar: "0.8277886497064579",
            RGB_r: "252",
            RGB_g: "178",
            RGB_b: "23"
        },
        {
            scalar: "0.8297455968688845",
            RGB_r: "252",
            RGB_g: "179",
            RGB_b: "24"
        },
        {
            scalar: "0.831702544031311",
            RGB_r: "252",
            RGB_g: "180",
            RGB_b: "25"
        },
        {
            scalar: "0.8336594911937377",
            RGB_r: "252",
            RGB_g: "181",
            RGB_b: "26"
        },
        {
            scalar: "0.8356164383561644",
            RGB_r: "251",
            RGB_g: "182",
            RGB_b: "27"
        },
        {
            scalar: "0.837573385518591",
            RGB_r: "251",
            RGB_g: "183",
            RGB_b: "28"
        },
        {
            scalar: "0.8395303326810175",
            RGB_r: "251",
            RGB_g: "184",
            RGB_b: "29"
        },
        {
            scalar: "0.8414872798434442",
            RGB_r: "251",
            RGB_g: "185",
            RGB_b: "30"
        },
        {
            scalar: "0.8434442270058709",
            RGB_r: "251",
            RGB_g: "186",
            RGB_b: "31"
        },
        {
            scalar: "0.8454011741682974",
            RGB_r: "251",
            RGB_g: "187",
            RGB_b: "32"
        },
        {
            scalar: "0.847358121330724",
            RGB_r: "251",
            RGB_g: "188",
            RGB_b: "33"
        },
        {
            scalar: "0.8493150684931506",
            RGB_r: "251",
            RGB_g: "189",
            RGB_b: "34"
        },
        {
            scalar: "0.8512720156555773",
            RGB_r: "251",
            RGB_g: "190",
            RGB_b: "35"
        },
        {
            scalar: "0.8532289628180039",
            RGB_r: "251",
            RGB_g: "191",
            RGB_b: "37"
        },
        {
            scalar: "0.8551859099804304",
            RGB_r: "250",
            RGB_g: "192",
            RGB_b: "38"
        },
        {
            scalar: "0.8571428571428571",
            RGB_r: "250",
            RGB_g: "193",
            RGB_b: "39"
        },
        {
            scalar: "0.8590998043052838",
            RGB_r: "250",
            RGB_g: "194",
            RGB_b: "40"
        },
        {
            scalar: "0.8610567514677103",
            RGB_r: "250",
            RGB_g: "195",
            RGB_b: "41"
        },
        {
            scalar: "0.8630136986301369",
            RGB_r: "250",
            RGB_g: "196",
            RGB_b: "43"
        },
        {
            scalar: "0.8649706457925636",
            RGB_r: "250",
            RGB_g: "197",
            RGB_b: "44"
        },
        {
            scalar: "0.8669275929549902",
            RGB_r: "250",
            RGB_g: "198",
            RGB_b: "45"
        },
        {
            scalar: "0.8688845401174168",
            RGB_r: "249",
            RGB_g: "199",
            RGB_b: "46"
        },
        {
            scalar: "0.8708414872798433",
            RGB_r: "249",
            RGB_g: "200",
            RGB_b: "48"
        },
        {
            scalar: "0.87279843444227",
            RGB_r: "249",
            RGB_g: "201",
            RGB_b: "49"
        },
        {
            scalar: "0.8747553816046967",
            RGB_r: "249",
            RGB_g: "202",
            RGB_b: "50"
        },
        {
            scalar: "0.8767123287671232",
            RGB_r: "249",
            RGB_g: "203",
            RGB_b: "51"
        },
        {
            scalar: "0.8786692759295498",
            RGB_r: "249",
            RGB_g: "204",
            RGB_b: "53"
        },
        {
            scalar: "0.8806262230919765",
            RGB_r: "248",
            RGB_g: "205",
            RGB_b: "54"
        },
        {
            scalar: "0.8825831702544031",
            RGB_r: "248",
            RGB_g: "205",
            RGB_b: "55"
        },
        {
            scalar: "0.8845401174168297",
            RGB_r: "248",
            RGB_g: "206",
            RGB_b: "57"
        },
        {
            scalar: "0.8864970645792563",
            RGB_r: "248",
            RGB_g: "207",
            RGB_b: "58"
        },
        {
            scalar: "0.8884540117416829",
            RGB_r: "247",
            RGB_g: "208",
            RGB_b: "60"
        },
        {
            scalar: "0.8904109589041096",
            RGB_r: "247",
            RGB_g: "209",
            RGB_b: "61"
        },
        {
            scalar: "0.8923679060665362",
            RGB_r: "247",
            RGB_g: "210",
            RGB_b: "62"
        },
        {
            scalar: "0.8943248532289627",
            RGB_r: "247",
            RGB_g: "211",
            RGB_b: "64"
        },
        {
            scalar: "0.8962818003913894",
            RGB_r: "247",
            RGB_g: "212",
            RGB_b: "65"
        },
        {
            scalar: "0.898238747553816",
            RGB_r: "246",
            RGB_g: "213",
            RGB_b: "67"
        },
        {
            scalar: "0.9001956947162426",
            RGB_r: "246",
            RGB_g: "214",
            RGB_b: "68"
        },
        {
            scalar: "0.9021526418786692",
            RGB_r: "246",
            RGB_g: "215",
            RGB_b: "70"
        },
        {
            scalar: "0.9041095890410958",
            RGB_r: "246",
            RGB_g: "216",
            RGB_b: "71"
        },
        {
            scalar: "0.9060665362035225",
            RGB_r: "245",
            RGB_g: "217",
            RGB_b: "73"
        },
        {
            scalar: "0.9080234833659491",
            RGB_r: "245",
            RGB_g: "218",
            RGB_b: "75"
        },
        {
            scalar: "0.9099804305283756",
            RGB_r: "245",
            RGB_g: "219",
            RGB_b: "76"
        },
        {
            scalar: "0.9119373776908023",
            RGB_r: "245",
            RGB_g: "220",
            RGB_b: "78"
        },
        {
            scalar: "0.913894324853229",
            RGB_r: "244",
            RGB_g: "221",
            RGB_b: "79"
        },
        {
            scalar: "0.9158512720156555",
            RGB_r: "244",
            RGB_g: "222",
            RGB_b: "81"
        },
        {
            scalar: "0.9178082191780821",
            RGB_r: "244",
            RGB_g: "223",
            RGB_b: "83"
        },
        {
            scalar: "0.9197651663405088",
            RGB_r: "244",
            RGB_g: "224",
            RGB_b: "84"
        },
        {
            scalar: "0.9217221135029354",
            RGB_r: "244",
            RGB_g: "225",
            RGB_b: "86"
        },
        {
            scalar: "0.923679060665362",
            RGB_r: "243",
            RGB_g: "226",
            RGB_b: "88"
        },
        {
            scalar: "0.9256360078277885",
            RGB_r: "243",
            RGB_g: "227",
            RGB_b: "90"
        },
        {
            scalar: "0.9275929549902152",
            RGB_r: "243",
            RGB_g: "228",
            RGB_b: "92"
        },
        {
            scalar: "0.9295499021526419",
            RGB_r: "243",
            RGB_g: "229",
            RGB_b: "93"
        },
        {
            scalar: "0.9315068493150684",
            RGB_r: "242",
            RGB_g: "230",
            RGB_b: "95"
        },
        {
            scalar: "0.933463796477495",
            RGB_r: "242",
            RGB_g: "230",
            RGB_b: "97"
        },
        {
            scalar: "0.9354207436399217",
            RGB_r: "242",
            RGB_g: "231",
            RGB_b: "99"
        },
        {
            scalar: "0.9373776908023483",
            RGB_r: "242",
            RGB_g: "232",
            RGB_b: "101"
        },
        {
            scalar: "0.9393346379647749",
            RGB_r: "242",
            RGB_g: "233",
            RGB_b: "103"
        },
        {
            scalar: "0.9412915851272015",
            RGB_r: "242",
            RGB_g: "234",
            RGB_b: "105"
        },
        {
            scalar: "0.9432485322896281",
            RGB_r: "242",
            RGB_g: "235",
            RGB_b: "107"
        },
        {
            scalar: "0.9452054794520548",
            RGB_r: "241",
            RGB_g: "236",
            RGB_b: "109"
        },
        {
            scalar: "0.9471624266144814",
            RGB_r: "241",
            RGB_g: "237",
            RGB_b: "111"
        },
        {
            scalar: "0.9491193737769079",
            RGB_r: "241",
            RGB_g: "237",
            RGB_b: "113"
        },
        {
            scalar: "0.9510763209393346",
            RGB_r: "241",
            RGB_g: "238",
            RGB_b: "115"
        },
        {
            scalar: "0.9530332681017613",
            RGB_r: "241",
            RGB_g: "239",
            RGB_b: "117"
        },
        {
            scalar: "0.9549902152641878",
            RGB_r: "241",
            RGB_g: "240",
            RGB_b: "119"
        },
        {
            scalar: "0.9569471624266144",
            RGB_r: "241",
            RGB_g: "241",
            RGB_b: "121"
        },
        {
            scalar: "0.958904109589041",
            RGB_r: "242",
            RGB_g: "241",
            RGB_b: "123"
        },
        {
            scalar: "0.9608610567514677",
            RGB_r: "242",
            RGB_g: "242",
            RGB_b: "125"
        },
        {
            scalar: "0.9628180039138943",
            RGB_r: "242",
            RGB_g: "243",
            RGB_b: "127"
        },
        {
            scalar: "0.9647749510763208",
            RGB_r: "242",
            RGB_g: "244",
            RGB_b: "130"
        },
        {
            scalar: "0.9667318982387475",
            RGB_r: "242",
            RGB_g: "244",
            RGB_b: "132"
        },
        {
            scalar: "0.9686888454011742",
            RGB_r: "243",
            RGB_g: "245",
            RGB_b: "134"
        },
        {
            scalar: "0.9706457925636007",
            RGB_r: "243",
            RGB_g: "246",
            RGB_b: "136"
        },
        {
            scalar: "0.9726027397260273",
            RGB_r: "243",
            RGB_g: "246",
            RGB_b: "138"
        },
        {
            scalar: "0.974559686888454",
            RGB_r: "244",
            RGB_g: "247",
            RGB_b: "140"
        },
        {
            scalar: "0.9765166340508806",
            RGB_r: "244",
            RGB_g: "248",
            RGB_b: "142"
        },
        {
            scalar: "0.9784735812133072",
            RGB_r: "245",
            RGB_g: "248",
            RGB_b: "144"
        },
        {
            scalar: "0.9804305283757337",
            RGB_r: "245",
            RGB_g: "249",
            RGB_b: "146"
        },
        {
            scalar: "0.9823874755381604",
            RGB_r: "246",
            RGB_g: "249",
            RGB_b: "148"
        },
        {
            scalar: "0.9843444227005871",
            RGB_r: "246",
            RGB_g: "250",
            RGB_b: "150"
        },
        {
            scalar: "0.9863013698630136",
            RGB_r: "247",
            RGB_g: "251",
            RGB_b: "152"
        },
        {
            scalar: "0.9882583170254402",
            RGB_r: "248",
            RGB_g: "251",
            RGB_b: "154"
        },
        {
            scalar: "0.9902152641878669",
            RGB_r: "248",
            RGB_g: "252",
            RGB_b: "155"
        },
        {
            scalar: "0.9921722113502935",
            RGB_r: "249",
            RGB_g: "252",
            RGB_b: "157"
        },
        {
            scalar: "0.9941291585127201",
            RGB_r: "250",
            RGB_g: "253",
            RGB_b: "159"
        },
        {
            scalar: "0.9960861056751467",
            RGB_r: "250",
            RGB_g: "253",
            RGB_b: "161"
        },
        {
            scalar: "0.9980430528375733",
            RGB_r: "251",
            RGB_g: "254",
            RGB_b: "163"
        },
        {
            scalar: "1.0",
            RGB_r: "252",
            RGB_g: "255",
            RGB_b: "164"
        }
    ]

// Flat RGB lookup built once from the table above; the drawing loop indexes it
// directly instead of searching the table per bin.
const COLOR_LUT = (() => {
    const lut = new Uint8Array(plasmaColorScale_512.length * 3);
    for (let i = 0; i < plasmaColorScale_512.length; ++i) {
        const c = plasmaColorScale_512[i];
        lut[i * 3] = +c.RGB_r;
        lut[i * 3 + 1] = +c.RGB_g;
        lut[i * 3 + 2] = +c.RGB_b;
    }
    return lut;
})();

const LUT_LAST = plasmaColorScale_512.length - 1;
