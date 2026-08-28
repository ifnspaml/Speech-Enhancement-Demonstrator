FROM ubuntu:noble

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

RUN apt update && apt install -y sudo openssh-server openssh-client curl git python3 python3-pip python3-django python3-django-channels python3-daphne python3-channels-redis nodejs npm vim redis
RUN adduser --quiet --disabled-password --shell /bin/bash -home /home/devuser --gecos "User" devuser && echo "devuser:password" | chpasswd && usermod -aG sudo devuser

#RUN pip install -r requirements.txt
#EXPOSE 8000

#CMD python manage.py runserver 0.0.0.0:8000
