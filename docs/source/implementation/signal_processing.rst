Signal processing
=================

Everything between the microphone and the model, and back again. The whole
pipeline is defined at 16 kHz, so one millisecond is 16 samples throughout.

Framing
-------

Audio arrives from Web Audio in 128-sample render quanta and is accumulated into
one hop before anything else happens. ``hop_size`` must therefore be a positive
multiple of 128; 128 (8 ms) and 256 (16 ms) are the sizes in use.

Frames are handed to the frontend one hop at a time, and the frontend keeps the
overlap from previous calls internally. Nothing in the chain buffers a whole
utterance — the design constraint throughout is that a hop in must produce a hop
out.

The filter bank
---------------

Analysis and synthesis use an STFT. ONNX implements no STFT or FFT operator and
no suitable frame-wise JavaScript implementation was available, so the transform
is implemented against
a JavaScript `FFT library <https://github.com/auroranockert/fft.js>`_ by
`Aurora Nockert <https://github.com/auroranockert>`_, mirroring the PyTorch
reference implementation used in training.

Windows are ``sqrt_hann`` by default, periodic (the ``torch.hann_window``
convention) unless ``window_periodic`` says otherwise. Synthesis is overlap-add.

``frontend_type`` exists to select the frontend but currently accepts only
``stft``; a config asking for anything else is rejected at load with a clear
message rather than silently producing the wrong framing.

Spectrum packing
~~~~~~~~~~~~~~~~

Models receive a real-valued packed frame, not complex numbers — ONNX cannot
carry complex tensors. The layout is padding, then ``n_fft / 2 + 1`` real parts,
then padding again, then the matching imaginary parts:

.. code-block:: text

   [ pad | Re[0..K] | pad | Im[0..K] ]     K = n_fft / 2

``pad_size`` is the padding the model expects on each half, and must match what
the network was exported with.

Preprocessing stages
--------------------

``preprocessing`` is a list of stages applied before the model, each with a
``type`` and an ``enabled`` flag. A stage marked ``significant: true`` changes the
signal enough to be worth showing on its own, which is what makes the
*Preprocessed* panel and transmission mode available.

============================  =========  ===================================================
Type                          Domain     Purpose
============================  =========  ===================================================
``delay_compensation``        time       Aligns the reference channel with the microphone.
``diffusion_noise``           spectral   Noise estimate injection for diffusion models.
============================  =========  ===================================================

Time-domain stages run on the samples before analysis; spectral stages run on the
frames, each against the raw microphone and reference spectra, writing their
results into the model's feature inputs. The last enabled spectral stage's
enhanced output is what the *Preprocessed* panel shows — never an echo estimate,
even when a stage produces both.

Delay compensation
~~~~~~~~~~~~~~~~~~

Echo cancellation needs the reference aligned with the microphone, and the offset
is a property of the device: output buffer, air path, input buffer. With
``autoCalibrate``, the stage uses the delay measured by **Measure delay** in the
debug panel and stored per capture device.

The measurement plays a noise burst through the same reference path used at
runtime and cross-correlates the recorded microphone and reference hops. Because
the reference is tapped before the output device, what it measures is exactly the
offset the stage has to remove.

Chunking and lookahead
----------------------

A model may consume several frames per call and may need future context:

* ``chunk_size`` — frames consumed per call, and frames of output produced.
* ``lookahead`` — future frames the model needs as context.

The worker holds ``chunk_size + lookahead`` frames, runs the model over the
window, keeps the lookahead tail as the next window's head, and emits the
``chunk_size`` output-aligned frames into the queue the synthesis stage draws
from.

Both cost latency. The lookahead costs ``lookahead × hop_size`` outright — this
is the figure the debug panel reports. Chunking adds up to
``(chunk_size − 1) × hop_size`` on top, depending on where a given frame falls in
its chunk.

Output modes
------------

``output_mode`` says how the model output is applied:

* ``direct`` — the output *is* the enhanced spectrum.
* ``mask`` (the default) — the output multiplies the frame it belongs to, which
  is always an output-aligned frame, never lookahead context.

Both then go through the synthesis transform. Note that every path does: bypass,
unprocessed, preprocessed and fully processed alike are all reconstructed by the
same synthesis stage, so a device pays its frontend's delay even when it is
enhancing nothing.

Input normalisation
-------------------

Models are trained at a particular input level. ``input_normalization`` brings
the signal to it:

.. code-block:: json

   {
     "enabled": true,
     "level_db": -26.0,
     "zero_mean": true,
     "ref": "both",
     "time_constant_s": 1.0,
     "denormalize_output": true
   }

``ref: "both"`` applies a per-stream gain; ``"noisy"`` derives one gain from the
microphone and applies it to every stream, which is what echo-cancellation models
generally expect. ``denormalize_output`` undoes the gain after synthesis so the
transmitted level matches the input.

This is separate from the user-facing microphone gain, which is applied in the
audio graph before any of this and exists to get a quiet handset into a sensible
range in the first place.

Algorithmic delay
-----------------

The delay the pipeline contributes, per pass, is three terms:

============================  =============================================
Term                          Cost
============================  =============================================
Hop fill                      ``hop_size − 128`` samples
Filter bank                   ``window − hop`` samples
Model lookahead               ``lookahead × hop_size`` samples
Chunk alignment               0 … ``(chunk_size − 1) × hop_size`` samples
============================  =============================================

The filter-bank term is measurable directly: pushing an impulse through analysis
and synthesis with no model in between produces the output that many samples
later.

=============================  ===========  =========
Configuration                  Lag
=============================  ===========  =========
Window 512, hop 128            384 samples  24.0 ms
Window 512, hop 256            256 samples  16.0 ms
=============================  ===========  =========

Hop size trades the first term against the second, so the two configurations
above cost the same 24 ms from opposite directions.

Inference time is *not* part of this budget: a late model result is replaced by
the unenhanced frame rather than delaying the audio.

In a full round trip — one participant speaking until they hear their own echo
returned — this contribution is real but small next to the transport and the
audio hardware. Two passes of a plain STFT frontend total 48 ms; Bluetooth
headphones alone commonly cost three times that.
