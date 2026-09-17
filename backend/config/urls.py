import re

from django.conf import settings
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path, re_path

from apps.core.views import activity_stream
from common.media import serve_media
from config.api import api


def healthz(_request):
    """Healthcheck del container (Docker/Coolify): nessuna query al DB, deve restare leggero."""
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("healthz", healthz),
    path("admin/", admin.site.urls),
    # Stream SSE: vista Django "nuda" (StreamingHttpResponse), registrata prima
    # del mount di Ninja così la risolve Django e non il router.
    path("api/core/activity/stream", activity_stream),
    path("api/", api.urls),
]

if settings.DEBUG or settings.SERVE_MEDIA:
    # Gli upload (logo salone, foto schede tecniche, allegati note, immagini
    # comunicazioni) li serve Django: whitenoise indicizza i file all'avvio e
    # non li vedrebbe. La vista è la stessa in sviluppo e in produzione, così i
    # percorsi riservati richiedono il token firmato in entrambi i casi
    # (`static()` di Django li avrebbe serviti a chiunque con DEBUG=1).
    urlpatterns += [
        re_path(
            r"^%s(?P<path>.*)$" % re.escape(settings.MEDIA_URL.lstrip("/")),
            serve_media,
        )
    ]
