"""Rate limit condiviso fra gli endpoint pubblici.

Il contatore vive su una tabella dedicata (`core.RateLimitCounter`) e non sulla
cache di Django. La cache di questo progetto è `DatabaseCache`, il cui `incr()`
eredita da `BaseCache` la sequenza leggi-poi-scrivi: non è atomico, e la
scrittura riporta la scadenza al TIMEOUT predefinito. Un limite chiesto su
un'ora durava così cinque minuti e due richieste simultanee contavano per una.

Qui l'incremento è una sola `UPDATE ... SET count = count + 1` filtrata sulla
finestra ancora valida: lo esegue il database, quindi due processi in parallelo
contano due volte. La scadenza è un campo nostro e resta quella richiesta.
"""

from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

__all__ = ["client_ip", "hit", "peek", "reset", "purge_expired"]


def _model():
    # Import differito: `common` è importato dalle app, non il contrario.
    from apps.core.models import RateLimitCounter

    return RateLimitCounter


def client_ip(request) -> str:
    """IP reale del chiamante, tenendo conto del proxy.

    Si prende l'ULTIMO elemento di X-Forwarded-For, non il primo: la catena è
    scrivibile dal client, ma il nostro proxy accoda in fondo il peer che ha
    davvero aperto la connessione. Fidarsi del primo elemento renderebbe ogni
    rate limit aggirabile con un header.
    """
    xff = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
    if xff:
        return xff.split(",")[-1].strip() or "unknown"
    return request.META.get("REMOTE_ADDR") or "unknown"


def hit(key: str, limit: int, window_seconds: int) -> bool:
    """Registra un tentativo su `key`. Falso quando il limite è già stato superato."""
    model = _model()
    now = timezone.now()
    expires = now + timedelta(seconds=window_seconds)
    live = model.objects.filter(key=key, expires_at__gt=now)

    if not live.update(count=F("count") + 1):
        # Nessuna finestra viva: o è scaduta (si riparte da 1) o non esiste.
        if not model.objects.filter(key=key, expires_at__lte=now).update(count=1, expires_at=expires):
            try:
                with transaction.atomic():
                    model.objects.create(key=key, count=1, expires_at=expires)
            except IntegrityError:
                # Un'altra richiesta ha creato la riga nello stesso istante:
                # il nostro tentativo va contato sulla sua finestra.
                live.update(count=F("count") + 1)

    count = model.objects.filter(key=key).values_list("count", flat=True).first()
    return (count or 1) <= limit


def peek(key: str) -> int:
    """Tentativi già contati su `key` (0 se la finestra è vuota o scaduta)."""
    row = (
        _model()
        .objects.filter(key=key, expires_at__gt=timezone.now())
        .values_list("count", flat=True)
        .first()
    )
    return row or 0


def reset(key: str) -> None:
    """Azzera la finestra: si usa dopo un tentativo andato a buon fine."""
    _model().objects.filter(key=key).delete()


def purge_expired() -> int:
    """Elimina le finestre scadute. La chiama il job `flush_outbox`."""
    deleted, _ = _model().objects.filter(expires_at__lte=timezone.now()).delete()
    return deleted
