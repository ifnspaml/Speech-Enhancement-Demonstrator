from django.db import models


class Room(models.Model):
    room_name = models.CharField(max_length=100, unique=True)

    # The model selected when the page loads. Kept as the single source of
    # truth for rooms that offer only one, so existing rooms behave unchanged.
    model_name = models.CharField(max_length=100)

    # Every model this room may switch between. Empty means "just model_name",
    # which is what pre-existing rooms migrate to.
    model_names = models.JSONField(default=list, blank=True)

    def available_models(self):
        """Selectable models, default first, no duplicates."""
        names = [self.model_name] if self.model_name else []
        for name in (self.model_names or []):
            if name and name not in names:
                names.append(name)
        return names

    title = models.CharField(
        max_length=200,
        blank=True,
        default=""
    )
    description = models.TextField(
        blank=True,
        default=""
    )

    def __str__(self):
        return self.room_name
