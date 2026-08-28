# This is the library for the Onnx-Exporter for statefull ONNX
# The Result has the needed new inputs and Outputs of every GRU-Layer
# for the Framewise input of the Neural Networks
# You need Python 3.10 for this file, onnx is not supported with newer versions
import os.path
import onnx
import yaml
from onnx import helper


def load_model(outputPath):
    return onnx.load(outputPath)


def save_model(model, outputPath):
    onnx.save(model, (outputPath + ".onnx"))


def node_builder(model, type_proto):
    # here we build all nodes for the model graph in the modified variant
    graph_def = model.graph
    nodes = graph_def.node
    modified_nodes = search_nodes(nodes)

    for i in range(len(modified_nodes)):
        if modified_nodes[i].op_type == "GRU" or modified_nodes[i].op_type == "LSTM":
            new_model_input(model, "input" + str(i + 2), type_proto)
            new_model_output(model, "output" + str(i + 2), type_proto)
            modified_nodes[i].input[5] = "input" + str(i + 2)
            modified_nodes[i].output[1] = "output" + str(i + 2)
    return modified_nodes


def new_model_input(model, name, type_proto):
    inter = helper.ValueInfoProto(type=type_proto)
    inter.name = name
    model.graph.input.append(inter)


def new_model_output(model, name, type_proto):
    inter = helper.ValueInfoProto(type=type_proto)
    inter.name = name
    model.graph.output.append(inter)


def search_nodes(nodes):
    lstm_or_gru_node = []
    for node in nodes:
        if node.op_type == "LSTM" or node.op_type == "GRU":
            lstm_or_gru_node.append(node)
    return lstm_or_gru_node


def graph_builder(model, modified):
    graph_def = model.graph
    all_nodes = list_of_all_nodes(graph_def, modified)
    new_graph_def = onnx.helper.make_graph(
        nodes=all_nodes,
        name=graph_def.name,
        inputs=graph_def.input,
        outputs=graph_def.output,
        initializer=graph_def.initializer,
    )
    return new_graph_def


def list_of_all_nodes(graph_def, modified):
    # All Nodes must in the right order
    all_nodes = []

    i = 0
    for node in graph_def.node:
        if (node.op_type != "GRU") and (node.op_type != "LSTM"):
            all_nodes.append(node)
        else:
            all_nodes.append(modified[i])
            i += 1

    return all_nodes


def load_config(path):
    print(os.path.abspath(path))
    with open(path, 'r') as file:
        conf = yaml.safe_load(file)
    return conf
