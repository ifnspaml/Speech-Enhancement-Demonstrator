# Speech Enhancement Demonstrator

Real-time speech enhancement demonstrator as shown on IWAENC 2026, Cremona, Italy. Upfront note: Enhancement models presented at IWAENC are currently not included. We might add some in the future.

This framework was originally created by Moritz Marksteller, Richard Wolff-Klammer Milián, and Simon Tarras. It was later modified by Marvin Sach and Ernst Seidel. Framework and documentation overhaul was conducted with the help of Claude Opus 5.4.

## Overview

A browser-based demonstrator for real-time speech enhancement models. Two people
open the same room on two devices, talk to each other over WebRTC, and each
device runs an ONNX model over its own microphone signal in real time — with
live spectrograms of the raw and enhanced signals side by side, and a switch to
turn the enhancement on and off mid-sentence.

It exists to deliver insights in real-world model performance that offline test sets do not answer. Everything runs in the browser: no inference server, no native app, no upload of audio files.

- **Real-time, in the browser.** ONNX Runtime Web (WebGPU where available, WASM
  SIMD otherwise) driven from an `AudioWorklet` at a fixed 16 kHz.
- **A/B against the unprocessed signal.** Toggle enhancement live; the two
  spectrogram panels show any pair of the microphone, enhanced, far-end
  reference and preprocessed signals.
- **Echo cancellation included.** Two-input models receive the far-end signal as
  a reference, with per-device delay calibration.
- **Several models per room.** Switch model live, optionally for every
  participant at once; seamless when the frame geometry matches.
- **Built for showing to an audience.** Per-device wording sets, presenter
  control of the other participants, a demo-signal player, and a debug panel
  that reports what the pipeline is actually doing.

## Table of contents

- [Quick start](#quick-start)
- [How a demo runs](#how-a-demo-runs)
- [Adding a model](#adding-a-model)
- [Model configuration reference](#model-configuration-reference)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Browser support](#browser-support)
- [Security and deployment status](#security-and-deployment-status)
- [TLS certificates and the signaling WebSocket](#tls-certificates-and-the-signaling-websocket)
- [Documentation](#documentation)
- [License](#license)

## Quick start

Requires Docker with the Compose plugin.

```
docker compose build
docker compose up -d
```

This starts two services: the demonstrator on `:8000` (HTTPS by default, with
the signaling WebSocket on the same origin) and the Sphinx documentation on
`:80`. To run just one:

```
docker compose up django
docker compose up sphinx
```

Database migrations run on every start, so there is nothing to do by hand.
**No models are bundled** — see [Adding a model](#adding-a-model).

Managing models and rooms requires a Django staff account. Create it through the
environment, so it lands in the database the running server uses:

```
DJANGO_SUPERUSER_USERNAME=admin DJANGO_SUPERUSER_PASSWORD=<pick one> \
  docker compose up django
```

The account is created once and the variables can be dropped afterwards.

> Do not create the account with `docker run … createsuperuser` in a throwaway
> container: `compose.yaml` mounts `./src` over the image, so the account is
> written to the container's own copy of `db.sqlite3` and is gone when it exits.
> The symptom is a correct password being rejected later.

Then open `https://localhost:8000/`, sign in at `/admin/`, upload an ONNX/config
pair under **Manage Models**, and create a room under **Manage Rooms**.

The default certificate is self-signed, so the first visit shows a warning.
See [TLS certificates](#tls-certificates-and-the-signaling-websocket) for the
options — and note that browsers block the microphone entirely outside a secure
context, so plain HTTP only works on `http://localhost`.

### Configuration

All optional; the defaults are for a single machine.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVE_PROTOCOL` | `https` | `http` skips the certificate, and then only `http://localhost` can use the microphone. |
| `DJANGO_ALLOWED_HOSTS` | localhost only | Comma-separated hostnames the server answers for. |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | empty | Origins allowed to POST, **with scheme and port**: `https://demo.example.org:8000`. Needed to sign in over HTTPS under a hostname. |
| `DJANGO_SECRET_KEY` | random per start | Set it to keep sessions across restarts. |
| `DJANGO_DEBUG` | off | Never enable on a reachable deployment; it serves tracebacks containing settings. |
| `DJANGO_SECURE_COOKIES` | off | Session and CSRF cookies HTTPS-only. Breaks `http://localhost` use. |
| `DJANGO_SECURE_SSL_REDIRECT` | off | Redirect HTTP to HTTPS. |
| `DJANGO_TRUST_PROXY_SSL_HEADER` | off | Only with a reverse proxy that sets `X-Forwarded-Proto`. |
| `SSL_CERT_FILE` / `SSL_KEY_FILE` / `SSL_INT_FILE` | dev certificate | Host paths mounted as the server certificate, key and chain. |

For local development without Docker, see [`dev_environment/`](dev_environment/).

## How a demo runs

Open the same room on two devices and press **Start** on both. Each device
captures its own microphone, runs the model locally, and sends the processed
audio to the other over WebRTC. What each participant hears is the *other*
device's enhanced output.

The room page carries:

| Control | What it does |
| --- | --- |
| Start / Stop / Mute | Session control for this device. |
| Demo signal | Transmits a bundled speech file instead of the microphone — useful when demoing alone. |
| Enable enhancement | Bypasses the model without tearing anything down. The A/B switch. |
| Transmission mode | Which stage of the chain is transmitted: unprocessed, preprocessed, or fully processed. |
| Microphone gain | Pre-processing gain with a post-gain level meter and a target mark. |
| Model | Switches model live, for this device or for everyone in the room. |
| Panel selectors | Which signal each spectrogram shows: microphone, enhanced, reference or preprocessed. |

The debug panel adds capture-device selection, browser AGC/AEC/NS toggles,
delay calibration, per-device signal wording, presenter control of the other
participants, and live counters for the worker, worklet and transport.

Two features exist specifically for showing the demonstrator to an audience:

- **Signal wording.** A device can relabel its panels to describe what is
  happening on the *other* device — for a setup where the processing runs on a
  phone and a laptop screen shows the result. Selecting the `demo` wording also
  switches that device into a presenter role: local processing off, its
  enhancement toggle hidden, controls for the other participants shown, and
  model switches applied room-wide. Append `?labels=demo` to the room URL to
  open straight into it.
- **Remote control.** One device can mute the others and switch their
  enhancement on or off, so the whole demo is driven from a single handset.
  Accepting remote control is on by default and can be switched off per device;
  anything applied is announced on screen.

## Adding a model

No models are distributed with the framework — bring your own. A model is two
files with the same base name:

```
src/webserver/connection/static/models/<name>.onnx
src/webserver/connection/static/configs/<name>.json
```

Upload both through **Manage Models**, or drop them into those directories
directly. The config tells the client how to frame audio for the model, what its
inputs and outputs are called, and how to interpret its output.

The ONNX file must be frame-wise and stateful: it processes one frame (or a
short chunk) per call, and any recurrent state is carried through explicit extra
inputs and outputs rather than held inside the graph. `onnx_exporter/` converts
a trained PyTorch model into that form and emits a matching config:

```
pip install -r onnx_exporter/requirements.txt
cd onnx_exporter/statefull
python example_export.py --output example_model      # add --inputs 2 for AEC
```

Run as-is it exports a small untrained example network and checks it by running
two frames through the result, which is the quickest way to confirm the pipeline
works end to end. Adapting it to your own network is mostly a matter of pointing
`build_model()` at your module and checkpoint. The documentation covers the
process and its failure modes.

A room may offer several models. Any device in the room can switch between them,
and the room editor warns when models differ in ways that make them awkward to
compare — different hop sizes cost the seamless swap, different input counts
mean one of them cannot do echo cancellation.

## Model configuration reference

Minimal single-input example:

```json
{
  "n_fft": 512,
  "hop_size": 128,
  "win_size": 512,
  "pad_size": 0,
  "inputs": 1,
  "outputs": 1,
  "input_shape": [1, 2, 257, 1],
  "output_mode": "direct",
  "name_of_inputs": ["input"],
  "name_of_outputs": ["output"]
}
```

### Framing

| Key | Meaning |
| --- | --- |
| `n_fft` | FFT size. Bin count is `n_fft / 2 + 1`. |
| `hop_size` | Samples per frame. Must be a multiple of 128 (the Web Audio render quantum). |
| `win_size` | Analysis window length. |
| `pad_size` | Zero padding in front of the packed spectrum, as the model expects it. |
| `window` | `sqrt_hann` (default) or `hann`. |
| `window_periodic` | Periodic (default, matches `torch.hann_window`) or symmetric. |

### Model interface

| Key | Meaning |
| --- | --- |
| `inputs` | Audio streams in: 1 for noise suppression, 2 for echo cancellation (microphone + far-end reference). |
| `model_feature_inputs` | Feature tensors the graph takes, if it differs from `inputs`. |
| `outputs` | Output tensors. |
| `input_shape` / `input_shapes` | Shape per feature input, NCHW with time last. |
| `new_input_shape` | Shape of the recurrent-state inputs added by the exporter. |
| `state_input_shapes` / `state_output_shapes` | Explicit state shapes, when they are not uniform. |
| `name_of_inputs` / `name_of_outputs` | ONNX tensor names, feature inputs first, then state. |
| `output_mode` | `direct` — the output is the enhanced spectrum. `mask` (default) — the output multiplies the input spectrum. |
| `model_path` | Overrides the default `/static/models/<name>.onnx`. |

### Chunking and lookahead

| Key | Meaning |
| --- | --- |
| `chunk_size` | Frames the model consumes per call. Defaults to the time dimension of `input_shape` minus `lookahead`. |
| `lookahead` | Future frames the model needs. Costs `lookahead × hop_size` of latency, reported in the debug panel. |

### Frontend

| Key | Meaning |
| --- | --- |
| `frontend_type` | `stft` — the only frontend in this distribution. A config naming another is rejected at load. |
| `real` | Real-valued frontend. Default true. |

### Preprocessing stages

`preprocessing` takes a list of stages run before the model. Each has a `type`
and an `enabled` flag; `significant: true` marks a stage whose output is worth
showing as its own signal.

| Type | Domain | Purpose |
| --- | --- | --- |
| `delay_compensation` | time | Aligns the reference channel with the microphone. `autoCalibrate` uses the measured per-device delay. |
| `diffusion_noise` | spectral | Noise estimate injection for diffusion-style models. |

### Input normalisation and runtime

| Key | Meaning |
| --- | --- |
| `input_normalization` | `{enabled, level_db, zero_mean, ref, time_constant_s, denormalize_output}` — brings the input to the level the model was trained at, and optionally undoes it on the way out. |
| `processing_ui` | Display names for the transmission-mode options. |
| `signal_labels` | Per-wording-set overrides for the spectrogram panel labels. |
| `disable_webgpu` / `force_wasm` | Pin the ONNX Runtime execution provider. |

## Architecture

```
Browser A                                            Browser B
┌──────────────────────────────────────┐             ┌───────────┐
│ microphone ──► AudioContext (16 kHz) │             │           │
│                     │                │             │           │
│                     ▼                │             │           │
│              AudioWorklet ──128 smp──┼── hop ──►   │           │
│                     ▲                │  Worker:    │           │
│                     │                │  STFT       │           │
│                     │                │  ONNX       │           │
│                     └────── frame ───┼──  ISTFT    │           │
│                     │                │             │           │
│                     ▼                │   spectra ──┼──► spectrogram
│         MediaStreamDestination       │             │    workers
│                     │                │             │  (OffscreenCanvas)
│                     ▼                │             │           │
│              RTCPeerConnection ──────┼── audio ────┼──► speaker│
└──────────────────────────────────────┘             └───────────┘
             │                                             │
             └──── signaling (Django Channels / Redis) ─────┘
```

The server is deliberately thin. Django serves the pages, the model files and
the configs, and a Channels consumer relays signaling messages between everyone
in a room over Redis. Audio never reaches it: media flows peer-to-peer over
WebRTC, and inference happens on each client.

On the client, three threads share the work. The `AudioWorklet` runs on the
audio thread, accumulating 128-sample render quanta into one hop and handing it
to a dedicated worker over a `MessageChannel`; it pops processed frames from a
FIFO so the audio callback never blocks. The worker owns the filter bank, the
ONNX session and the recurrent state; if a model result is late it falls back to
the unenhanced frame rather than stalling the graph, so slow inference costs
enhancement quality rather than latency. Two further workers own the spectrogram
canvases through `OffscreenCanvas`, keeping the drawing off the main thread.

The same signaling channel that sets up WebRTC also carries room-wide model
switches and presenter commands, which is why those work whether or not a call
is up.

## Repository layout

| Path | What it holds |
| --- | --- |
| `src/webserver/` | The Django project: rooms, model management, signaling. |
| `src/webserver/connection/static/webrtc.js` | Client application — capture, graph, WebRTC, UI. |
| `src/webserver/connection/static/js/` | Workers: ML inference, spectrograms, STFT tools, preprocessors. |
| `src/webserver/connection/static/models/`, `configs/` | Installed models and their configs. |
| `onnx_exporter/` | PyTorch → ONNX conversion, with a runnable example. |
| `docs/` | Sphinx documentation source. |
| `tools/*.sh` | Certificate generation, installation and inspection. |
| `dev_environment/` | Container for local development without Compose. |

## Browser support

The demo works in Chromium, Firefox and Safari. It needs a secure context
(`https://`, or `http://localhost`) for microphone access, plus:

| Feature                    | Chrome | Firefox | Safari |
| -------------------------- | ------ | ------- | ------ |
| 16 kHz AudioContext        | 74+    | 74+     | 14.1+  |
| AudioWorklet               | 66+    | 76+     | 14.1+  |
| OffscreenCanvas            | 69+    | 105+    | 16.4+  |
| Screen Wake Lock (optional)| 84+    | 126+    | 16.4+  |
| WebGPU (optional)          | 113+   | 141+    | 26+    |

Without OffscreenCanvas the spectrogram panels stay blank and everything else
keeps working. Without WebGPU, ONNX Runtime falls back to WASM automatically.

While processing runs the page holds a screen wake lock, so phones do not dim
and lock mid-demo; it is released on Stop. Browsers drop the lock whenever the
page stops being visible, so it is re-acquired when the page comes back to the
foreground. Where the API is missing the demo still works, but the screen may
sleep -- the "Screen Wake Lock" row in the debug panel shows the current state.

## Security and deployment status

**This is demonstration software.** It is written to be run on a network you
control, for an audience in the room with you.

What the defaults do give you:

- `DEBUG` off, no secret key in the repository, and `ALLOWED_HOSTS` limited to
  localhost until you widen it.
- Model upload, room creation and both delete actions require a Django staff
  account; anonymous visitors get a redirect to the login page and do not see
  the management links.

What is still yours to decide:

- **Rooms are unlisted but not private.** Anyone who can reach the server can
  open the room list and join a session. There is no per-room access control.
- **An uploaded model is executed in every participant's browser.** Only give
  staff accounts to people you would trust to run code on those devices.
- Media is peer-to-peer and unencrypted beyond WebRTC's own DTLS-SRTP, with no
  TURN server configured — participants need a network path to each other.

For anything reachable beyond a controlled network, put it behind a reverse
proxy with real authentication, set `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`,
`DJANGO_CSRF_TRUSTED_ORIGINS` and `DJANGO_SECURE_COOKIES`, and use a CA-issued
certificate.

## TLS certificates and the signaling WebSocket

Browsers scope TLS certificate exceptions per `host:port`. If the page is on
`:8000` and the WebSocket on `:8001` behind a self-signed certificate, accepting
the certificate for the page does *not* cover the socket, and a WebSocket cannot
show a certificate prompt. Chromium scopes its click-through bypass per *host*, which is why a
split-port setup can appear to work there while failing in Firefox and Safari.

Same-origin means one certificate and one exception in every browser.

### Serving without TLS

`SERVE_PROTOCOL` switches the transport:

```
SERVE_PROTOCOL=http docker compose up django     # no certificate, no warning
docker compose up django                          # https, the default
```

**This does not make the demo usable for participants.** Browsers gate
`getUserMedia`, `AudioWorklet`, `RTCPeerConnection` and the wake lock behind a
*secure context*, which means `https://` **or** `http://localhost`. Reached over
`http://` at a hostname or LAN address, `navigator.mediaDevices` is not merely
restricted, it is absent — the page loads and Start fails. The page detects this
and shows a warning on load rather than failing silently.

Plain HTTP is genuinely useful for:

- a single-machine demo on `http://localhost:8000`
- a phone reached through `adb reverse tcp:8000 tcp:8000`, where the handset
  really does see `http://localhost:8000` and therefore gets a secure context

To avoid the warning screen for participants on their own devices you need a
certificate their browser already trusts — see below. Note that verifying a
CA-issued certificate does **not** require internet access: browsers check it
against the trust store shipped with the device. Revocation checks may reach the
network, but browsers soft-fail those. An offline demo on a CA-issued
certificate is fine, provided the hostname resolves and the certificate has not
expired.

### Installing a certificate from your IT department

A CA delivery usually contains the same certificate in several formats and
**never** a private key. You need three things:

| what | where it comes from | setting |
| --- | --- | --- |
| certificate for your hostname | the CA | `SSL_CERT_PATH` |
| chain (intermediate CAs) | the CA, usually glued into a "bundle" | `SSL_INT_PATH` |
| private key | generated by *you* with the signing request | `SSL_KEY_PATH` |

`tools/install-cert.sh` splits a bundle into the first two, checks the pieces
belong together, and writes them out:

```
tools/install-cert.sh --bundle <name>_pemBundle.pem                       --key    /path/to/privkey.pem                       --dest   /etc/ssl/private/demo
```

Prefer the `pemBundle.pem` over the `pkcs7.pem`: bundles often carry an extra
cross-signed CA certificate that helps older devices, and the PKCS#7 file may
not. `certOnly.pem` is the certificate *without* the chain -- do not use it on
its own for an offline demo.

Choose a `--dest` outside the repository for a real key. `src/webserver/cert`
is listed in `.gitignore`, but the files already in it are tracked, and git does
not ignore tracked files -- a key placed there would be committed.

Then confirm what a browser will actually see:

```
tools/check-cert.sh --cert .../cert.pem --key .../privkey.pem                     --chain .../chain.pem --probe your.host:8000
```

### Offline demo (no internet on the server or the devices)

HTTPS works fully offline. Certificate validation is local: browsers check the
chain against the root store shipped with the device. Revocation checks (OCSP,
CRL) may reach the network, but browsers soft-fail them, so losing internet does
not cause a warning.

Three things must hold, and none of them need connectivity:

1. **The server must send the intermediate(s).** Offline devices cannot fetch a
   missing intermediate from the certificate's AIA URL, so a leaf-only server is
   rejected. Set `SSL_INT_PATH`; the entrypoint passes it to daphne as
   `extraCertChain`.
2. **The chain file must be PEM.** Files named `.cer` are often DER, which
   daphne cannot read -- it dies at startup with a `UnicodeDecodeError`.
   Convert with `openssl x509 -inform DER -in chain.cer -out chain.pem`.
3. **The certificate's hostname must resolve to the server.** With no internet
   there is no DNS, so run one on the access point. With dnsmasq on a Raspberry
   Pi acting as the AP:

   ```
   address=/your.demo.hostname/192.168.4.1
   ```

   Devices reaching it by IP instead will get a name-mismatch warning, because
   the certificate is issued for the name, not the address.

Check all of this before the demo:

```
tools/check-cert.sh --cert CERT --key KEY --chain CHAIN --probe host:8000
```

It reports PEM/DER, expiry, the SANs devices must use, whether the key matches,
and -- with `--probe` against a running server -- how many certificates it
actually puts on the wire.

### Development certificate

The certificate in `src/webserver/cert` is self-signed. To generate one that is
actually valid for the hostnames you use:

```
tools/make-dev-cert.sh [extra-hostname-or-ip ...]
```

`localhost`, `127.0.0.1`, `::1` and the machine's own hostname are always
included. Restart the server.

### Production certificates

`compose.yaml` mounts the certificate the entrypoint serves, defaulting to the
development pair in `src/webserver/cert/`. Point it at your own with host paths:

```
SSL_CERT_FILE=/etc/ssl/private/demo/cert.pem \
SSL_KEY_FILE=/etc/ssl/private/demo/privkey.pem \
SSL_INT_FILE=/etc/ssl/private/demo/chain.pem \
  docker compose up django
```

Inside the container these arrive as `SSL_CERT_PATH`, `SSL_KEY_PATH` and
`SSL_INT_PATH`. When a host path does not exist, Docker creates a directory at
the mount point; the entrypoint detects that and falls back to the self-signed
pair with a warning in the log rather than failing to start.

### Splitting signaling onto another host

Only worthwhile if that host has a certificate the browser already trusts. Set
either environment variable on the Django service:

```
SIGNALING_WS_PORT=8001                                   # same host, other port
SIGNALING_WS_URL=wss://signaling.example.org/ws/connection/{room}/
```

`{room}` is substituted with the room name. Both unset means same-origin.

## Documentation

Full documentation lives in [`docs/source/`](docs/source/) and is served on
`:80` by the `sphinx` service:

- **Usage** — running a demo, managing models and rooms, troubleshooting.
- **Implementation** — architecture, signal processing and latency, the model
  configuration reference, exporting models from PyTorch, and the validation of
  the JavaScript inference against the PyTorch reference.

## License

MIT — see [LICENSE](LICENSE).

Bootstrap, ONNX Runtime Web and fft.js are redistributed under their own
licences; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
