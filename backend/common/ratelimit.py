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

import ipaddress
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

__all__ = ["client_ip", "hit", "peek", "reset", "purge_expired"]


def _model():
    # Import differito: `common` è importato dalle app, non il contrario.
    from apps.core.models import RateLimitCounter

    return RateLimitCounter


# Reti da cui può arrivare solo il nostro reverse proxy: quelle interne del
# datacenter e di Docker. Sono elencate a mano e non dedotte da `is_private`,
# che in Python 3.12 comprende anche gli intervalli di documentazione (RFC 5737,
# quelli che si usano negli esempi e nei test) e ci farebbe fidare di indirizzi
# che in un altro ambiente potrebbero essere reali.
_TRUSTED_PROXY_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "127.0.0.0/8",     # localhost (rete host, healthcheck del container)
        "10.0.0.0/8",
        "172.16.0.0/12",   # rete bridge di Docker: qui sta Traefik su Coolify
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",        # unique local address IPv6
        "fe80::/10",       # link-local IPv6
    )
)


def _is_trusted_peer(addr: str) -> bool:
    """Vero se chi ha aperto la connessione può essere il nostro reverse proxy.

    Con Traefik/Coolify il backend riceve la connessione dalla rete interna di
    Docker, o da localhost quando il container è in rete host: sono indirizzi
    che nessuno può raggiungere da fuori. `TRUSTED_PROXY_IPS` copre
    l'installazione in cui il proxy sta su un'altra macchina.
    """
    if addr in getattr(settings, "TRUSTED_PROXY_IPS", ()):
        return True
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in network for network in _TRUSTED_PROXY_NETWORKS if ip.version == network.version)


def client_ip(request) -> str:
    """IP reale del chiamante, tenendo conto del proxy.

    Due regole, e servono entrambe:

    1. X-Forwarded-For si legge solo se la connessione arriva dal proxy. È un
       header, cioè testo che scrive il client: se il container diventa
       raggiungibile direttamente (porta pubblicata per sbaglio, rete interna
       esposta) bastava cambiarlo a ogni richiesta per avere un secchiello
       nuovo ogni volta, e ogni tetto — login staff, registrazioni, OTP —
       spariva.
    2. Della catena si prende l'ULTIMO elemento, non il primo: il client può
       precompilare l'header con quello che vuole, ma il nostro proxy accoda in
       fondo il peer che ha davvero aperto la connessione.
    """
    remote = (request.META.get("REMOTE_ADDR") or "").strip()
    xff = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
    if xff and _is_trusted_peer(remote):
        return xff.split(",")[-1].strip() or remote or "unknown"
    return remote or "unknown"


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
