FROM python:3.10
ENV DockerHOME /home/app/src

RUN mkdir -p $DockerHOME
WORKDIR $DockerHOME

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

RUN apt update && apt install -y redis vim

RUN pip install --upgrade pip

#COPY ./src /home/app/src
ADD src/requirements.txt .

RUN pip install -r requirements.txt
EXPOSE 8000 8001

# One daphne process serves the pages, the static files and the signaling
# WebSocket, on both ports. Serving HTTP and WS from the same origin is what
# lets Firefox and Safari work. 8001 is kept listening so existing bookmarks/links stay valid.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]
