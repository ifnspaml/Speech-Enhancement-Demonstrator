Speech Enhancement Demonstrator
===============================

A browser-based demonstrator for real-time speech enhancement models. Two people
open the same room on two devices, talk to each other over WebRTC, and each
device runs an ONNX model over its own microphone signal in real time — with
live spectrograms of the raw and enhanced signals side by side, and a switch to
turn the enhancement on and off mid-sentence.

Everything runs in the browser. The server hands out the pages, the model files
and the signaling messages; it never sees any audio.

These pages cover running a demo and the implementation behind it. For
installation, TLS certificates and the model configuration reference, see the
``README.md`` in the repository root.

.. toctree::
   :maxdepth: 2
   :caption: Usage

   usage/usage

.. toctree::
   :maxdepth: 2
   :caption: Implementation

   implementation/implementation


Indices and tables
==================

* :ref:`genindex`
* :ref:`search`
