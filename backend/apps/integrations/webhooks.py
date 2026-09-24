"""Webhook in ingresso da Yourang: dall'evento notificato alla sincronizzazione giusta.

La notifica è sottile — {type, resource, resource_id, organization_id} — e
qui si decide che cosa riallineare. La firma si verifica prima, nell'endpoint
(api.py): da qui in poi l'evento è della connessione che l'ha firmato.
Le funzioni di sync si chiamano attraverso il modulo (`sync.import_event`…),
così chi le sostituisce in `apps.integrations.sync` le sostituisce anche qui.
"""

from . import sync


def dispatch(conn, event_type: str, entity_id: str) -> None:
    """Esegue la sync che l'evento richiede; un errore risale all'endpoint (503)."""
    if event_type == "contact.deleted":
        # Niente da fare: la scheda locale resta (storico, caparre, note) e
        # il suo contact-id non viene più usato; toglierlo farebbe
        # rispingere su Yourang, al prossimo giro, il contatto appena
        # cancellato lì. Prima qui partiva comunque la sync completa.
        pass
    elif event_type.startswith("contact") and entity_id:
        # Solo quel contatto: la sync completa (elenco + push di ogni
        # scheda non collegata) dentro ogni webhook costava migliaia di
        # chiamate a raffica. Il push resta al primo collegamento e al cron.
        sync.sync_contact(conn, entity_id)
    elif event_type.startswith("contact"):
        # Payload senza resource_id: riconciliazione completa, senza push.
        sync.sync_clients(conn, push=False)
    elif event_type == "event.deleted" and entity_id:
        # `and entity_id` come nel ramo gemello qui sotto: senza, un
        # event.deleted col campo assente arrivava a cancel_event con "" e
        # annullava l'INTERA agenda del salone in una sola UPDATE,
        # rispondendo pure 200 "ok".
        sync.cancel_event(conn, entity_id)
    elif event_type.startswith("event") and entity_id:
        sync.import_event(conn, entity_id)
