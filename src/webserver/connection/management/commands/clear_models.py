from django.core.management.base import BaseCommand

from connection.models import Room


class Command(BaseCommand):
    def handle(self, *args, **options):
        Room.objects.all().delete()
