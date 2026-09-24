"""Permessi per ambito (scope), come da manuale: ruoli con permessi per area.

Il titolare (Membership.is_owner) bypassa ogni controllo.
"""

from ninja.errors import HttpError

SCOPES = [
    "agenda",        # Agenda
    "clients",       # Schede cliente
    "sales",         # Vendite & checkout
    "inventory",     # Magazzino & rettifiche
    "pricing",       # Listino & prezzi
    "marketing",     # Coupon / fedeltà / marketing / comunicazioni / automazioni
    "team",          # Team & permessi / staff
    "activity_log",  # Registro attività
    "insights",      # Analisi dati
]


def has_scope(ctx, scope: str) -> bool:
    """Vero se chi chiama ha il permesso `scope`; il titolare li ha tutti.

    È la regola di `require_scope` per chi non deve rifiutare la richiesta ma
    solo decidere cosa mostrare: incassi a zero nella scheda cliente, costo
    orario nascosto, token dei webhook mascherati. Le viste la riscrivevano a
    mano (`ctx.is_owner or "sales" in ctx.scopes`) in sei punti, e una regola
    del titolare cambiata qui non sarebbe arrivata a nessuna delle copie.

    Stessa espressione e stesso ordine di valutazione delle copie: `scopes` non
    si legge nemmeno quando chi chiama è il titolare.
    """
    return ctx.is_owner or scope in ctx.scopes


def require_scope(ctx, scope: str) -> None:
    if has_scope(ctx, scope):
        return
    raise HttpError(403, f"Permesso mancante: {scope}")


def require_owner(ctx) -> None:
    if not ctx.is_owner:
        raise HttpError(403, "Funzione riservata al titolare")

# Nota: la mappa «quale permesso serve per vedere quale evento del feed live»
# vive in apps.core.livefeed (LIVE_FEED_SCOPES), accanto al codice che consegna gli
# eventi. Qui ne esisteva una seconda copia, mai chiamata da nessuno e già
# divergente dalla prima: due verità sullo stesso argomento, di cui una falsa.
