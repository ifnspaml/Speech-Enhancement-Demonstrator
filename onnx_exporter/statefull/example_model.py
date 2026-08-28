"""A minimal frame-wise speech enhancement network.

This exists to demonstrate the export, not to enhance speech: it is small,
untrained, and deliberately unremarkable. What matters is that its shapes and
its recurrence are those the demonstrator expects, so it can stand in for a real
model while you get the export working.

Shape contract, per call:

    input   (batch, 2, bins, 1)     channel 0 real, channel 1 imaginary
    output  (batch, 2, bins, 1)     the enhanced spectrum

``bins`` is ``n_fft // 2 + 1``. The trailing dimension is time: this is a
frame-wise model, so exactly one frame goes in and one comes out.

A two-input model additionally takes the far-end reference as a second tensor of
the same shape, which is what makes echo cancellation possible.

The recurrent layer is the point of the exercise. A GRU keeps state between
frames, and a model exported naively reinitialises that state on every call --
it then hears each frame in isolation and sounds nothing like the trained
system. ``example_export.py`` rewrites the exported graph so the state travels
in and out as ordinary tensors, which the browser threads from one frame to the
next.
"""

import torch
from torch import nn


class ExampleEnhancementNet(nn.Module):
    """Convolution over frequency, GRU over time, one gain per bin."""

    def __init__(self, bins: int = 257, channels: int = 4, hidden: int = 192,
                 inputs: int = 1):
        super().__init__()

        if inputs not in (1, 2):
            raise ValueError(f"inputs must be 1 or 2, got {inputs}")

        self.bins = bins
        self.inputs = inputs

        # Local spectral context: a kernel of 5 bins, no mixing across time,
        # because there is only ever one frame to mix.
        self.conv = nn.Conv2d(2 * inputs, channels, kernel_size=(5, 1),
                              padding=(2, 0))
        self.act = nn.GELU()

        self.fc_in = nn.Linear(channels * bins, hidden)
        self.gru = nn.GRU(hidden, hidden, batch_first=True)
        self.fc_out = nn.Linear(hidden, bins)

    def forward(self, mic: torch.Tensor,
                ref: torch.Tensor | None = None) -> torch.Tensor:
        x = mic if ref is None else torch.cat((mic, ref), dim=1)

        batch = x.shape[0]

        y = self.act(self.conv(x))          # (B, C, bins, 1)
        y = y.reshape(batch, 1, -1)         # (B, 1, C * bins) -- one time step
        y = self.fc_in(y)

        y, _ = self.gru(y)                  # state handled by the exporter

        # One real gain per bin, applied to the real and imaginary parts alike.
        gain = torch.sigmoid(self.fc_out(y))
        gain = gain.reshape(batch, 1, self.bins, 1)

        return mic * gain
