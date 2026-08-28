"""Export a PyTorch model to the frame-wise, stateful ONNX the demonstrator runs.

Run it as-is to produce a working model/config pair from the example network:

    python example_export.py --output example_model

That writes ``example_model.onnx`` and ``example_model.json``, which upload
together under **Manage Models**.

The three steps it performs are the same for any model:

1. Export the PyTorch module with ``torch.onnx.export``. Recurrent state is
   *not* handled here -- at this point the GRU still starts from zero on every
   call.
2. Rewrite the graph so each GRU or LSTM node reads its initial state from a new
   graph input and writes its final state to a new graph output. The browser
   feeds each frame's state outputs back as the next frame's state inputs.
3. Write the JSON config that tells the client how to frame audio, what the
   tensors are called, and what shape the state has.

Adapting it to your own network is mostly step 1: import your module, load your
checkpoint, and give ``--inputs`` and the framing parameters that match how it
was trained. Steps 2 and 3 read what they need from the exported graph.
"""

import argparse
import json
from pathlib import Path

import onnx
import torch

import exporter
from example_model import ExampleEnhancementNet

# ONNX GRU/LSTM operand positions. Both ops take the initial hidden state as
# input 5 and return it as output 1; LSTM carries a cell state alongside it.
GRU_STATE_INPUT = 5
GRU_STATE_OUTPUT = 1
LSTM_CELL_INPUT = 6
LSTM_CELL_OUTPUT = 2


def build_model(args):
    """Return the module to export, in eval mode.

    Replace this with your own model and checkpoint. The rest of the script does
    not care what the module is, only that it is frame-wise and recurrent.
    """
    model = ExampleEnhancementNet(
        bins=args.n_fft // 2 + 1,
        channels=args.channels,
        hidden=args.hidden,
        inputs=args.inputs,
    )

    if args.checkpoint:
        checkpoint = torch.load(args.checkpoint, map_location="cpu")

        # Checkpoints are rarely a bare state_dict, and the keys are rarely the
        # module's own. This is the step that usually needs adapting: strip the
        # wrapper prefix your training framework added.
        state_dict = checkpoint.get("state_dict", checkpoint)
        state_dict = {k.split(".", 1)[-1] if k.startswith("model.") else k: v
                      for k, v in state_dict.items()}
        model.load_state_dict(state_dict)

    return model.eval()


def example_inputs(args):
    """One frame of the right shape per feature input."""
    bins = args.n_fft // 2 + 1
    frame = torch.zeros(1, 2, bins, 1)
    return (frame,) if args.inputs == 1 else (frame, frame.clone())


def hidden_size_of(node, initializers):
    """Recover a recurrent node's state width from its recurrence weights.

    R has shape [directions, gates * hidden, hidden], so the last dimension is
    the hidden size whether the node is a GRU (3 gates) or an LSTM (4). Reading
    it here is what removes the old "export once, open it in Netron, and copy
    the shape by hand" step.
    """
    weights = initializers.get(node.input[2])
    if weights is None or len(weights.dims) != 3:
        raise RuntimeError(
            f"cannot determine the state shape of {node.op_type} node "
            f"'{node.name}': its recurrence weights are not a graph initializer"
        )

    directions, _, hidden = weights.dims
    return int(directions), int(hidden)


def state_tensor(name, shape):
    proto = onnx.helper.make_tensor_type_proto(
        elem_type=onnx.TensorProto.FLOAT, shape=shape, shape_denotation=None)
    return proto


def rewire_recurrent_state(model):
    """Give every GRU/LSTM node its own state input and output.

    Returns the modified nodes and the shape of each state tensor added, in the
    order they were appended to the graph.
    """
    initializers = {init.name: init for init in model.graph.initializer}
    nodes = exporter.search_nodes(model.graph.node)
    shapes = []

    for index, node in enumerate(nodes):
        directions, hidden = hidden_size_of(node, initializers)
        shape = [directions, 1, hidden]

        slots = [(GRU_STATE_INPUT, GRU_STATE_OUTPUT)]
        if node.op_type == "LSTM":
            slots.append((LSTM_CELL_INPUT, LSTM_CELL_OUTPUT))

        # Optional operands may have been omitted entirely; the slots have to
        # exist before they can be pointed at a new tensor. Pad only as far as
        # the op allows -- a GRU takes 6 inputs and 2 outputs, and the checker
        # rejects a seventh.
        last_input, last_output = slots[-1]
        while len(node.input) <= last_input:
            node.input.append("")
        while len(node.output) <= last_output:
            node.output.append("")

        for in_slot, out_slot in slots:
            suffix = len(shapes) + 2  # input2/output2 upwards, as before
            in_name, out_name = f"input{suffix}", f"output{suffix}"

            exporter.new_model_input(model, in_name, state_tensor(in_name, shape))
            exporter.new_model_output(model, out_name, state_tensor(out_name, shape))

            node.input[in_slot] = in_name
            node.output[out_slot] = out_name
            shapes.append(shape)

    if not shapes:
        print("[export] note: no GRU or LSTM nodes found, nothing to rewire")

    return nodes, shapes


def write_config(path, args, model, state_shapes):
    bins = args.n_fft // 2 + 1
    feature_shape = [1, 2, bins + args.pad_size, 1]

    config = {
        "n_fft": args.n_fft,
        "hop_size": args.hop_size,
        "win_size": args.win_size,
        "pad_size": args.pad_size,

        "inputs": args.inputs,
        "model_feature_inputs": args.inputs,
        "outputs": 1,

        "input_shape": feature_shape,
        "output_mode": "direct",

        "name_of_inputs": [i.name for i in model.graph.input],
        "name_of_outputs": [o.name for o in model.graph.output],

        "state_input_shapes": [list(s) for s in state_shapes],
        "state_output_shapes": [list(s) for s in state_shapes],
    }

    if args.inputs > 1:
        config["input_shapes"] = [list(feature_shape) for _ in range(args.inputs)]

    Path(path).write_text(json.dumps(config, indent=2) + "\n")
    return config


def verify(onnx_path, args, state_shapes):
    """Run two frames through the exported graph, feeding the state forward.

    If this passes, the browser will be able to drive the model the same way.
    """
    try:
        import onnxruntime
    except ImportError:
        print("[export] onnxruntime not installed, skipping the run-through")
        return

    session = onnxruntime.InferenceSession(onnx_path,
                                           providers=["CPUExecutionProvider"])
    import numpy as np

    input_names = [i.name for i in session.get_inputs()]
    output_names = [o.name for o in session.get_outputs()]

    bins = args.n_fft // 2 + 1
    features = [np.zeros((1, 2, bins, 1), dtype=np.float32)
                for _ in range(args.inputs)]
    states = [np.zeros(shape, dtype=np.float32) for shape in state_shapes]

    for frame in range(2):
        feeds = dict(zip(input_names, features + states))
        results = session.run(output_names, feeds)

        enhanced, new_states = results[0], results[1:]
        if enhanced.shape != (1, 2, bins, 1):
            raise RuntimeError(
                f"output shape {enhanced.shape} is not the expected "
                f"(1, 2, {bins}, 1)")
        if len(new_states) != len(states):
            raise RuntimeError("model returned the wrong number of state tensors")

        states = new_states  # what the browser does between frames

    print(f"[export] ran 2 frames; output {enhanced.shape}, "
          f"{len(states)} state tensor(s) carried forward")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", default="example_model",
                        help="base name for the .onnx and .json written")
    parser.add_argument("--checkpoint", help="optional weights to load")
    parser.add_argument("--inputs", type=int, default=1, choices=(1, 2),
                        help="1 for noise suppression, 2 to also take the "
                             "far-end reference for echo cancellation")
    parser.add_argument("--n-fft", type=int, default=512)
    parser.add_argument("--hop-size", type=int, default=128,
                        help="must be a multiple of 128")
    parser.add_argument("--win-size", type=int, default=512)
    parser.add_argument("--pad-size", type=int, default=0,
                        help="padding the model expects around the packed "
                             "spectrum; 0 unless your network needs it")
    parser.add_argument("--channels", type=int, default=4)
    parser.add_argument("--hidden", type=int, default=192)
    parser.add_argument("--opset", type=int, default=17,
                        help="ONNX opset to export against. ONNX Runtime Web "
                             "lags the newest opset, so the default is a "
                             "conservative one that browsers accept.")
    args = parser.parse_args()

    if args.hop_size % 128:
        parser.error("--hop-size must be a multiple of 128, the Web Audio "
                     "render quantum")

    onnx_path = f"{args.output}.onnx"
    json_path = f"{args.output}.json"

    # 1. plain export -- no state plumbing yet.
    #
    # dynamo=False selects the TorchScript exporter deliberately. PyTorch's
    # newer dynamo exporter emits a graph this script cannot rewire: it feeds
    # the recurrence weights through Unsqueeze nodes instead of leaving them as
    # initializers, so the state width cannot be read off them, and it drops the
    # GRU's second output entirely when the module discards it.
    # Naming the feature tensors keeps the generated config readable; the state
    # tensors the next step adds are named input2/output2 upwards.
    feature_names = ["mic"] if args.inputs == 1 else ["mic", "reference"]

    torch.onnx.export(build_model(args), example_inputs(args), onnx_path,
                      input_names=feature_names, output_names=["enhanced"],
                      opset_version=args.opset, dynamo=False)
    print(f"[export] wrote {onnx_path}")

    # 2. thread the recurrent state through the graph boundary
    model = exporter.load_model(onnx_path)
    feature_inputs = len(model.graph.input)

    nodes, state_shapes = rewire_recurrent_state(model)

    # Rebuild around the new graph, carrying the original opset and IR version
    # across. Without this the model is stamped with whatever the installed onnx
    # package considers newest, which the runtime in the browser will refuse to
    # load.
    rebuilt = onnx.helper.make_model(
        exporter.graph_builder(model, nodes),
        opset_imports=list(model.opset_import),
    )
    rebuilt.ir_version = model.ir_version
    onnx.checker.check_model(rebuilt)
    onnx.save(rebuilt, onnx_path)
    model = rebuilt

    print(f"[export] {feature_inputs} feature input(s), "
          f"{len(state_shapes)} state tensor(s): "
          f"{', '.join(str(s) for s in state_shapes) or 'none'}")

    # 3. the config the browser reads
    write_config(json_path, args, model, state_shapes)
    print(f"[export] wrote {json_path}")

    verify(onnx_path, args, state_shapes)


if __name__ == "__main__":
    main()
