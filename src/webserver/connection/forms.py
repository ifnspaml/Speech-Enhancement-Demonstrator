import json
import os

from django import forms

from .models import Room

CONFIG_DIR = "connection/static/configs/"


def selecting():
    # Search for available ONNX models in the static model directory
    models = []
    models_file = os.listdir("connection/static/models/")

    for model in models_file:
        splitted = model.split(sep=".")
        model_name = splitted[0]
        models.append((model_name, model_name))

    return models


def load_model_config(name):
    try:
        with open(os.path.join(CONFIG_DIR, f"{name}.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def compare_model_configs(names):
    """Flag differences that make models awkward to compare or swap.

    None of these break anything -- each client rebuilds its whole chain per
    model -- so they are warnings, not validation errors.
    """
    configs = {n: load_model_config(n) for n in names}
    known = {n: c for n, c in configs.items() if c}
    warnings = []

    missing = [n for n, c in configs.items() if not c]
    if missing:
        warnings.append(
            f"No config found for {', '.join(missing)}; it cannot be checked "
            f"for compatibility."
        )

    if len(known) < 2:
        return warnings

    def group(fn):
        out = {}
        for n, c in known.items():
            out.setdefault(fn(c), []).append(n)
        return out

    # hop_size and inputs are the AudioWorklet's construction parameters, so a
    # difference forces a worklet rebuild and costs the seamless swap.
    hops = group(lambda c: c.get("hop_size"))
    if len(hops) > 1:
        warnings.append(
            "Different hop sizes ("
            + "; ".join(f"{h}: {', '.join(ns)}" for h, ns in hops.items())
            + "). Switching between them briefly interrupts the audio instead "
            "of being seamless."
        )

    inputs = group(lambda c: c.get("inputs"))
    if len(inputs) > 1:
        warnings.append(
            "Different input counts ("
            + "; ".join(f"{i} input(s): {', '.join(ns)}" for i, ns in inputs.items())
            + "). Single-input models cannot do echo cancellation, so this is "
            "not a like-for-like comparison."
        )

    # Latency differences: audible, and worth knowing when A/B-ing. The window
    # and the look-ahead are the two terms a model can differ in; the hop is
    # already reported above.
    delays = group(lambda c: (
        int(c.get("lookahead", 0) or 0),
        int(c.get("chunk_size", 1) or 1),
        int(c.get("win_size", 0) or 0),
    ))
    if len(delays) > 1:
        parts = []
        for (la, chunk, win), ns in delays.items():
            bits = [f"look-ahead {la}"]
            if chunk > 1:
                bits.append(f"chunk {chunk}")
            if win:
                bits.append(f"window {win}")
            parts.append(f"{', '.join(bits)}: {', '.join(ns)}")
        warnings.append(
            "Different algorithmic delay (" + "; ".join(parts) + "). One model "
            "will feel more responsive than the other."
        )

    ffts = group(lambda c: c.get("n_fft"))
    if len(ffts) > 1:
        warnings.append(
            "Different FFT sizes ("
            + "; ".join(f"{n}: {', '.join(ns)}" for n, ns in ffts.items())
            + "). Swapping works, but the spectrogram resolution changes with it."
        )

    return warnings


class RoomForm(forms.ModelForm):
    model_name = forms.ChoiceField(
        choices=(),
        required=True,
        label="Default model",
        help_text="Selected when the room is opened.",
    )
    model_names = forms.MultipleChoiceField(
        choices=(),
        required=False,
        widget=forms.CheckboxSelectMultiple,
        label="Also available in this room",
        help_text="Tick extra models to make them switchable from the demo page. "
                  "Leave empty for a single-model room.",
    )

    def __init__(self, model_choices, *args, **kwargs):
        super(RoomForm, self).__init__(*args, **kwargs)
        self.fields['model_name'].choices = model_choices
        self.fields['model_names'].choices = model_choices
        self.config_warnings = []

    def clean(self):
        cleaned = super().clean()
        default = cleaned.get('model_name')
        extra = list(cleaned.get('model_names') or [])

        # The default is always available; storing it twice would just duplicate
        # it in the dropdown.
        names = [default] if default else []
        for name in extra:
            if name and name not in names:
                names.append(name)
        cleaned['model_names'] = names

        if len(names) > 1:
            self.config_warnings = compare_model_configs(names)

        return cleaned

    class Meta:
        model = Room
        fields = ('room_name', 'model_name', 'model_names', 'title', 'description')
        widgets = {
            'room_name': forms.TextInput(attrs={
                'placeholder': 'e.g. demo-room-1'
            }),
            'title': forms.TextInput(attrs={
                'placeholder': 'e.g. Microphone vs. Enhanced Signal'
            }),
            'description': forms.Textarea(attrs={
                'rows': 4,
                'placeholder': 'Short explanation shown at the top of the demo page'
            }),
        }


class UploadFileForm(forms.Form):
    model_name = forms.CharField(
        max_length=100,
        widget=forms.TextInput(attrs={
            "placeholder": "e.g. convtest"
        })
    )
    file = forms.FileField()
    config_file = forms.FileField()
