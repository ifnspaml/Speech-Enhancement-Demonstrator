from django.urls import path
from django.conf.urls.static import static
from django.conf import settings

from . import views

app_name = "connection"

urlpatterns = [
    path("", views.home, name="home"),

    path("connection/", views.room_list, name="room_list"),
    path("connection/<int:room_id>/", views.room_detail, name="room_detail"),

    path("connection/rooms/", views.room_manage, name="room_manage"),
    path("connection/rooms/delete/<int:room_id>/", views.room_delete, name="room_delete"),

    path("connection/models/", views.model_manage, name="model_manage"),
    path("connection/models/delete/<str:model_name>/", views.model_delete, name="model_delete"),
]

urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
