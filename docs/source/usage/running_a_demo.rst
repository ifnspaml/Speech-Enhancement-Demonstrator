Running a demo
==============

A demo needs a room, a model assigned to it, and two devices. Both devices open
the same room URL and press **Start**. Each captures its own microphone, runs the
model locally, and sends the processed audio to the other over WebRTC — so what
each participant hears is the *other* device's enhanced output.

Creating rooms and installing models is covered in
:doc:`managing_models_and_rooms`.

Before you start
----------------

The microphone is only available in a secure context: ``https://`` or
``http://localhost``. Over plain HTTP at a hostname or LAN address,
``navigator.mediaDevices`` is absent entirely and **Start** fails. The page
detects this on load and shows a warning rather than failing silently.

Browser-side automatic gain control, echo cancellation and noise suppression are
off by default, because they process the signal before the model sees it and
would compete with what the demo is showing. If any of them are active, a warning
chip appears in the header naming which.

The room page
-------------

Session controls
~~~~~~~~~~~~~~~~

**Start** builds the audio graph, acquires the microphone and announces the
device to the room. **Stop** tears it down for this device only. **Mute** stops
transmitting without leaving.

**Demo signal** replaces the microphone with a bundled speech file as the
transmitted signal. It is the way to demonstrate alone, and the way to get a
repeatable input when comparing models. The button only appears when the room's
model config offers a demo file.

Enhancement and transmission
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Enable enhancement** bypasses the model without tearing anything down — this is
the A/B switch, and the point of the demonstrator. The status chip in the header
tracks it: *Enhancement active*, *Bypass mode*, or *Processing inactive* before
Start.

**Transmission mode** selects which stage of the chain is actually transmitted:

* *Unprocessed microphone* — the captured signal.
* *Preprocessed* — after the preprocessing stages, before the model. Only
  offered when the model config enables a stage that changes the signal
  significantly.
* *Fully processed* — the model output. The default.

The mode only applies while enhancement is on; in bypass the unprocessed signal
is transmitted regardless.

Microphone gain
~~~~~~~~~~~~~~~

Models are trained at a particular input level, and a handset that captures
quietly will underperform for reasons that have nothing to do with the model. The
gain slider applies a fixed gain before processing, and the meter under it shows
the post-gain level with a mark at the level the processing expects: while
speaking normally, the bar should reach the mark. The bar turns amber when the
level is too low and red when it clips.

Choosing what the spectrograms show
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Each panel has its own selector, and any pair can be compared:

* **Microphone** — the captured signal after gain.
* **Enhanced** — the model output.
* **Reference / Loudspeaker** — the far-end signal the model receives as its
  echo-cancellation reference. Only available for two-input models.
* **Preprocessed** — the result of the spectral preprocessing stages. Only
  available when the config enables one.

Unavailable signals are greyed out rather than hidden, and the choice is
remembered: switching to a model that cannot offer the selected signal falls back
temporarily, and switching back restores it.

Switching models
~~~~~~~~~~~~~~~~

When a room offers more than one model, a **Model** selector appears. Switching
loads the new model completely before anything is swapped, so a failure leaves
the running session untouched.

If the new model has the same hop size and input count as the current one, the
running worklet is handed a port to the new worker and the audio keeps flowing.
Otherwise the worklet node is rebuilt, which costs a short gap. The room editor
warns about this when the models are assigned.

**Switch for everyone** applies the change to every device in the room over the
signaling channel, so an audience sees both ends change together.

Presenting on two devices
-------------------------

The common demo setup has the processing running on a phone while a laptop screen
shows the result to an audience. Two features support it.

Signal wording
~~~~~~~~~~~~~~

Under **Debug / Status Panel → Presentation**, the *Signal wording* selector
changes what this screen calls each signal. It applies to this device only and is
remembered locally, so the phone and the laptop can be labelled differently.

* ``technical`` — the engineering vocabulary. The default.
* ``demo`` — describes what is happening on the *other* device: the panels read
  *Far-End Microphone*, *Transmitted Far-end Audio*, *Enhanced Near-End Audio*.

Selecting ``demo`` also switches the device into a presenter role, on the
assumption that the screen showing the demo is not the device doing the work:

* local processing is turned off and its toggle hidden, as is the transmission
  mode selector;
* the spectrogram panels are fixed to the transmitted and returning signals, and
  their selectors are hidden;
* the controls for other participants are shown;
* model switches are applied room-wide;
* control labels name which end they act on — *Other participants (NE)*,
  *Model (NE)*, *FE microphone gain* — and the page heading gains a
  *— Far-End* suffix.

Switching back to ``technical`` reveals the hidden controls again but does not
undo what was switched on. Append ``?labels=demo`` to the room URL to open a
display straight into this mode.

Note that a device in this role still runs its audio through the filter bank even
though it enhances nothing, so it still contributes its analysis–synthesis delay.
See :doc:`../implementation/signal_processing`.

Controlling the other participants
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Under **Debug / Status Panel → Remote control**, *Show controls for other
participants* adds a group to the control card that mutes the others and switches
their enhancement on or off, so the whole demo can be driven from one handset.
The status line reports what the other devices currently report, including when
they disagree.

*Accept remote control of this device* is on by default — the same room-wide
trust that already lets a peer change your model. Untick it to opt out. Any
command that is applied is announced on screen, so a remote change is never
mistaken for the demo misbehaving.

Delay compensation
------------------

Echo cancellation needs the reference signal aligned with the microphone signal,
and the offset between them is a property of the device: its output buffer, the
air path, and its input buffer. Under **Debug / Status Panel → Delay
Compensation**, **Measure delay** plays a short noise burst through the real
output path and cross-correlates it against the microphone. The result is stored
per capture device and applied automatically when the model config enables the
``delay_compensation`` stage with ``autoCalibrate``.

Measure once per device, in the room where you will demo, with the loudspeaker at
the volume you will use. The reported confidence indicates how clear the
correlation peak was; a low value usually means the loudspeaker was too quiet or
the microphone was muted.

The debug panel
---------------

Beyond the controls above, the panel reports what the pipeline is doing:

* **System state** — WebSocket, worker and worklet status, masking, transmission
  mode, mute, gain, post-gain level, wake lock, peer count.
* **Browser-Side Capture Options** — capture device selection and the browser's
  own AGC/AEC/NS toggles, with the settings remembered per microphone.
* **Model / runtime** — the loaded model, hop and FFT size, input count, chunk
  and lookahead with the resulting delay in milliseconds, sample rate, and
  whether preprocessing is enabled.
* **Processing / performance** — frames received, processed and dropped by the
  worker, messages exchanged with the worklet, and output underruns.

A steadily rising underrun or dropped-frame count means the device is not
keeping up; see :doc:`troubleshooting`.

Screen wake lock
----------------

While processing runs the page holds a screen wake lock so phones do not dim and
lock mid-demo. It is released on Stop, and browsers drop it whenever the page
stops being visible, so it is re-acquired when the page returns to the
foreground. Where the API is missing the demo still works, but the screen may
sleep — the *Screen Wake Lock* row shows the current state.
