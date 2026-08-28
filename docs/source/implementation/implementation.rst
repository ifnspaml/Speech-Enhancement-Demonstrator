Implementation
==============

How the demonstrator is put together: the threads audio passes through, the
signal processing around the model, how a PyTorch model becomes an ONNX file the
client can run, and the evidence that the JavaScript inference matches the
PyTorch reference.

.. toctree::
   :maxdepth: 2

   architecture
   signal_processing
   exporting_models
   validation
