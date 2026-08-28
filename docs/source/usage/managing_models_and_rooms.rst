Managing models and rooms
=========================

The home page has three entries: **Open a Room**, **Manage Rooms** and **Manage
Models**. The first is open to everyone; the other two require a staff account
and are hidden from anonymous visitors. A room cannot be created without a
model, and no models are distributed with the framework, so a fresh installation
starts at Manage Models.

Signing in
----------

Model upload, room creation and both delete actions are staff-only. Visiting
them signed out redirects to the Django admin login.

Create the account through the environment, so that it is written to the same
database the running server uses:

.. code-block:: console

   DJANGO_SUPERUSER_USERNAME=admin DJANGO_SUPERUSER_PASSWORD=<pick one> \
     docker compose up django

The entrypoint creates it on start and says so in the log; if the user already
exists it does nothing. The variables can be dropped from later runs.

.. warning::

   Do not create the account with ``createsuperuser`` inside a throwaway
   ``docker run`` container. ``compose.yaml`` mounts ``./src`` over the image, so
   a container started without that mount has its own copy of ``db.sqlite3``: the
   account is written there and disappears when the container exits. The symptom
   afterwards is a correct password being rejected, which looks like a broken
   login rather than a missing account.

   To check which is happening, count the users in the database the server
   actually uses:

   .. code-block:: console

      docker compose exec django python manage.py shell -c \
        "from django.contrib.auth.models import User; print(User.objects.count())"

Installing a model
------------------

A model is two files with the same base name:

.. code-block:: text

   src/webserver/connection/static/models/<name>.onnx
   src/webserver/connection/static/configs/<name>.json

**Manage Models** uploads both together. It asks for a name, the ``.onnx`` file
and the ``.json`` config; the name determines what both files are stored as, and
what appears in the room editor. On success the page lists the model among the
installed ones.

The upload is rejected — with a plain error page, having stored nothing — when:

* either file is missing, or has the wrong extension;
* a model of that name is already installed. Delete it first.

The ONNX file must be frame-wise and stateful: it processes one frame or a short
chunk per call, with any recurrent state carried through explicit extra inputs
and outputs. :doc:`../implementation/exporting_models` covers producing such a
file from a trained PyTorch model, and the configuration reference in the
repository ``README.md`` covers every field the config may carry.

Files can also be placed in those two directories directly, which is how the
models shipped with the repository are installed.

Creating a room
---------------

**Manage Rooms** creates a room from a name, one or more models, and optionally a
title and description shown as the page heading and subtitle.

A room's first model is the one loaded when the page opens. Any further models
are offered in the room's **Model** selector, and any participant can switch
between them live.

When several models are assigned, the editor checks them against each other and
warns — without blocking — about differences that matter in a demo:

* **Different hop sizes.** These are fixed when the ``AudioWorkletNode`` is
  constructed, so switching between them rebuilds the node and briefly
  interrupts the audio instead of being seamless.
* **Different input counts.** A single-input model has no echo-cancellation
  reference, so comparing it against a two-input model is not like for like.
* **Different lookahead or chunk size.** The models differ in latency, which is
  audible when switching and worth knowing when A/B-ing.

A config that cannot be read is reported too: the room still works, the models
simply cannot be checked against each other.

Deleting
--------

Both delete buttons act immediately, without a confirmation step.

Deleting a **room** removes only that room.

Deleting a **model** removes both its files — the ``.onnx`` and the ``.json``,
whichever of the two you clicked — and every room that had it as its *default*
model, since such a room cannot work without it. A room that merely offered the
model as one of several alternatives is kept, with the name dropped from its
list. Check what depends on a model before removing it.

Administrative access
---------------------

Django's admin site is available at ``/admin`` and is the place to inspect or
edit rooms directly. It uses the same staff account as the management pages.

If the password is lost and the username is known:

.. code-block:: console

   python manage.py shell

.. code-block:: python

   from django.contrib.auth.models import User
   User.objects.get(username="jdoe", is_superuser=True).delete()

If the username is not known either, ``python manage.py flush --noinput`` clears
the whole database — including every room — after which the superuser and the
rooms must be recreated. Model files on disk are not touched.
