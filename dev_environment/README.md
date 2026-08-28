# Development container

A container for working on the code directly, without Compose. It mounts the
repository rather than copying it, so edits on the host take effect immediately
and the database persists between runs.

For running the demonstrator normally, use `docker compose up` from the
repository root instead — see the top-level [README](../README.md).

## Build

Bash:

```
docker build -t tp_devenv - < Dockerfile
```

PowerShell:

```
Get-Content Dockerfile | docker build -t tp_devenv -
```

## Run

Bash, from this directory:

```
docker run --rm -it -v $(pwd)/..:/mnt -p 8000:8000 -p 2222:22 tp_devenv
```

PowerShell:

```
docker run --rm -it -v <PATH_TO_THE_REPO>:/mnt -p 8000:8000 -p 2222:22 tp_devenv
```

The repository appears at `/mnt` inside the container.

## Start the server

```
cd /mnt/src/webserver
redis-server --daemonize yes
python3 manage.py migrate
python3 manage.py runserver 0.0.0.0:8000
```

`runserver` serves plain HTTP. Browsers only grant microphone access on
`http://localhost`, so reach it from the same machine — over a LAN address the
page loads but **Start** cannot capture anything. The Compose setup serves HTTPS
and does not have that limitation.

Managing models and rooms needs a staff account:

```
python3 manage.py createsuperuser
```

Here that is safe: the database lives in the mounted repository, so the account
survives the container. Creating one inside a container started *without* the
mount writes it to a copy that disappears on exit — the trap described in the
[documentation](../docs/source/usage/managing_models_and_rooms.rst).

## SSH access

Optional, for attaching an editor over SSH. In the container:

```
service ssh start
```

From the host:

```
ssh -p 2222 devuser@localhost
```

The password is `password`. It is fixed in the `Dockerfile` and this container
is for local development only — do not expose port 2222 beyond your own machine.

## A caveat on versions

The image installs Django, Channels, daphne and channels-redis from Ubuntu's
package repository, which does not track the versions pinned in
`src/requirements.txt`. Behaviour here can therefore differ slightly from the
Compose setup, which installs the pinned versions. When something works in one
and not the other, check the versions first:

```
python3 -c "import django, channels; print(django.__version__, channels.__version__)"
```
