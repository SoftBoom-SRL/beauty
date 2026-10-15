"""La forma delle risposte della scheda cliente, quando servono dati di altre app.

Il dettaglio (`client_detail`) e la pagina dell'elenco (`attach_amounts_due`)
mettono accanto alla scheda quello che vive altrove — visite e spesa (agenda e
cassa), quanto resta da saldare (`sales.dues`), l'affidabilità con i suoi
conteggi — e decidono cosa vede chi legge (`has_scope`). api.py resta sottile.
"""

from decimal import Decimal

from common.permissions import has_scope

from .models import Client
from .services import client_stats, reliability_basis


def contact_out(client: Client) -> dict:
    """Una scheda vista da un'altra (`ClientContactOut`)."""
    return {"id": client.id, "full_name": client.full_name, "phone": client.phone}


def client_detail(ctx, client: Client) -> Client:
    """La scheda con i campi calcolati di `ClientDetailOut`.

    Spesa totale, numero di visite, ultima visita e debito sono dati di cassa:
    li vede solo chi ha il permesso «vendite», come la lista degli incassi. A
    chi non ce l'ha la scheda arriva completa, con i contatori a zero, il
    debito a null e `stats_hidden`: senza quel flag l'interfaccia mostrava «0
    visite · 0 € spesi», una cliente storica sembrava alla prima visita e
    l'operatrice rischiava di trattarla come tale (caparra compresa).

    L'affidabilità esce ricalcolata, con i conteggi che la spiegano; se la
    colonna è rimasta indietro (un no-show uscito dalla finestra dei 12 mesi,
    che nessun gesto segnala) la si corregge qui, così la lista e i filtri la
    ritrovano giusta appena qualcuno apre la scheda.
    """
    from apps.sales.dues import client_amount_due  # lazy

    may_see = has_scope(ctx, "sales")
    if may_see:
        stats = client_stats(client)
    else:
        stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    client.visits = stats["visits"]
    client.total_spent = stats["total_spent"]
    client.last_visit = stats["last_visit"]
    client.stats_hidden = not may_see
    client.amount_due = client_amount_due(client) if may_see else None

    basis = reliability_basis(client)
    if basis["score"] != client.reliability:
        Client.objects.filter(pk=client.pk).update(reliability=basis["score"])
        client.reliability = basis["score"]
    client.reliability_basis = basis
    return client


def attach_amounts_due(ctx, clients: list) -> list:
    """Il debito di ogni cliente della pagina (`amount_due`), in una query sola.

    Solo a chi ha il permesso «vendite»: per gli altri resta null (nascosto),
    mai 0.
    """
    if not clients or not has_scope(ctx, "sales"):
        return clients
    from apps.sales.dues import amounts_due_by_client  # lazy

    dues = amounts_due_by_client(ctx.salon, [c.id for c in clients])
    for client in clients:
        client.amount_due = dues.get(client.id, Decimal("0.00"))
    return clients
