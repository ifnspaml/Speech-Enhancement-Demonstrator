from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import render, get_object_or_404, redirect
from .models import Room
from .forms import RoomForm, UploadFileForm, selecting
from django.core.files.storage import FileSystemStorage
from django.http import HttpResponse
import json
import os
import pathlib


def home(request):
    return render(request, "connection/home.html")


def room_list(request):
    room_list = Room.objects.all().order_by("room_name")
    return render(request, "connection/list_room.html", {
        "room_list": room_list
    })


def room_detail(request, room_id):
    room_object = get_object_or_404(Room, id=room_id)
    return render(request, "connection/bootstrap.html", {
        "room": room_object,
        "available_models_json": json.dumps(room_object.available_models()),
        # Empty by default: the client then opens the signaling WebSocket on the
        # page's own origin, which keeps it on a single TLS certificate. Only
        # set these if signaling really lives elsewhere and that host has a
        # certificate the browser already trusts.
        "signaling_ws_url": getattr(settings, "SIGNALING_WS_URL", ""),
        "signaling_ws_port": getattr(settings, "SIGNALING_WS_PORT", ""),
    })


@staff_member_required
def room_manage(request):
    # create/edit rooms and list existing rooms
    model_choices = selecting()
    saved_room = None
    room_list = Room.objects.all().order_by("room_name")

    config_warnings = []

    if request.method == "POST":
        form = RoomForm(model_choices, request.POST)
        if form.is_valid():
            saved_room = form.save(commit=True)
            # Advisory only: mismatched models still work, they just may not
            # compare like for like.
            config_warnings = form.config_warnings
            form = RoomForm(model_choices)
            room_list = Room.objects.all().order_by("room_name")
    else:
        form = RoomForm(model_choices)

    return render(request, "connection/config.html", {
        "form": form,
        "saved_room": saved_room,
        "room_list": room_list,
        "config_warnings": config_warnings,
    })


@staff_member_required
def model_manage(request):
    installed_models = get_installed_models()
    upload_success = False
    uploaded_model_name = None
    deleted_model_name = None

    if request.method == "POST":
        form = UploadFileForm(request.POST, request.FILES)

        if form.is_valid():
            model_name = form.cleaned_data["model_name"].strip()
            onnx_file = request.FILES.get("file")
            config_file = request.FILES.get("config_file")

            if onnx_file is None or config_file is None:
                return render(request, "connection/error.html")

            if not onnx_file.name.endswith(".onnx") or not config_file.name.endswith(".json"):
                return render(request, "connection/error.html")

            target_onnx = f"{model_name}.onnx"
            target_json = f"{model_name}.json"

            if pathlib.Path("connection/static/models/" + target_onnx).is_file() or \
               pathlib.Path("connection/static/configs/" + target_json).is_file():
                return render(request, "connection/error.html")

            handle_uploaded_file_with_name(onnx_file, target_onnx)
            handle_uploaded_config_file_with_name(config_file, target_json)

            upload_success = True
            uploaded_model_name = model_name
            form = UploadFileForm()
            installed_models = get_installed_models()
    else:
        form = UploadFileForm()

    return render(request, "connection/new_model.html", {
        "form": form,
        "installed_models": installed_models,
        "upload_success": upload_success,
        "uploaded_model_name": uploaded_model_name,
        "deleted_model_name": deleted_model_name,
    })

# def handle_uploaded_file(f):
#     # Helper for saving -> real saving
#     FileSystemStorage(location="connection/static/models").save(f.name, f)
#     return HttpResponse("Success")


# def handle_uploaded_config_file(f):
#     # Helper for saving -> real saving
#     FileSystemStorage(location="connection/static/configs").save(f.name, f)
#     return HttpResponse("Success")

def handle_uploaded_file_with_name(f, target_name):
    FileSystemStorage(location="connection/static/models").save(target_name, f)
    return HttpResponse("Success")


def handle_uploaded_config_file_with_name(f, target_name):
    FileSystemStorage(location="connection/static/configs").save(target_name, f)
    return HttpResponse("Success")


@staff_member_required
def room_delete(request, room_id):
    # Delete a room and return to the room management page
    obj = get_object_or_404(Room, id=room_id)
    obj.delete()
    return redirect("connection:room_manage")


@staff_member_required
def model_delete(request, model_name):
    model_file = f"connection/static/models/{model_name}.onnx"
    config_file = f"connection/static/configs/{model_name}.json"

    if os.path.isfile(model_file):
        os.remove(model_file)

    if os.path.isfile(config_file):
        os.remove(config_file)

    # A room whose default model is gone cannot work, so it goes too. A room
    # that merely offered it as an alternative keeps working once the name is
    # dropped from its list -- deleting the whole room would be gratuitous.
    Room.objects.filter(model_name=model_name).delete()

    for room in Room.objects.all():
        names = room.model_names or []
        if model_name in names:
            room.model_names = [n for n in names if n != model_name]
            room.save(update_fields=["model_names"])

    return redirect("connection:model_manage")

def get_installed_models():
    model_files = os.listdir("connection/static/models/")
    config_files = os.listdir("connection/static/configs/")

    names = set()

    for file in model_files:
        if file.endswith(".onnx"):
            names.add(os.path.splitext(file)[0])

    for file in config_files:
        if file.endswith(".json"):
            names.add(os.path.splitext(file)[0])

    return sorted(names)
