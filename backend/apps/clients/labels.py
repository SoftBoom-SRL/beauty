"""Etichette cliente (ClientCategory): nomi unici nel salone, condizioni che li citano, conteggi.

Le regole caparra (core.DepositRule) e le automazioni salvano nelle condizioni
il NOME dell'etichetta, che è quello che confronta `client_facts`: rinominare o
eliminare un'etichetta tocca anche loro, e le automazioni aggiornate si
rimandano a Yourang. api.py controlla i permessi, legge la riga del salone e
chiama queste funzioni.
"""

from typing import Optional

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from ninja.errors import HttpError

from apps.core.models import DepositRule
from apps.core.services import log_activity

from .models import Client, ClientCategory
from .schemas import ClientCategoryIn

DUPLICATE_LABEL = "Esiste già un'etichetta con questo nome"


def label_payload(ctx, data: ClientCategoryIn, *, exclude_id: Optional[int] = None) -> dict:
    """ClientCategoryIn ripulito, con il nome unico nel salone senza badare alle maiuscole.

    Un nome già usato (o il doppio clic su «Salva») arrivava al vincolo del
    database e usciva come 500 (06-12). E «VIP» accanto a «vip» sono due
    etichette che le condizioni non distinguono: `contains` confronta i nomi
    senza maiuscole.
    """
    payload = data.dict()
    payload["name"] = payload["name"].strip()
    if not payload["name"]:
        raise HttpError(400, "Il nome dell'etichetta è obbligatorio")
    same = ClientCategory.objects.filter(salon=ctx.salon, name__iexact=payload["name"])
    if exclude_id is not None:
        same = same.exclude(id=exclude_id)
    if same.exists():
        raise HttpError(400, DUPLICATE_LABEL)
    return payload


def _cites_label(rule, name: str) -> bool:
    return (
        isinstance(rule, dict)
        and rule.get("field") == "categories"
        and isinstance(rule.get("value"), str)
        and rule["value"].strip().casefold() == name.strip().casefold()
    )


def _label_rules(conditions) -> list:
    if not isinstance(conditions, dict) or not isinstance(conditions.get("rules"), list):
        return []
    return conditions["rules"]


def rules_citing_label(salon, name: str) -> tuple[list, list]:
    """Regole caparra e automazioni del salone le cui condizioni citano l'etichetta.

    Le condizioni salvano il NOME dell'etichetta (è quello che confronta
    `client_facts`, ed è quello che le automazioni mandano a Yourang).
    """
    rules = [
        r for r in DepositRule.objects.filter(salon=salon)
        if any(_cites_label(rule, name) for rule in _label_rules(r.conditions))
    ]
    from apps.automations.models import Automation  # lazy

    automations = [
        a for a in Automation.objects.filter(salon=salon)
        if any(_cites_label(rule, name) for rule in _label_rules(a.conditions))
    ]
    return rules, automations


def _renamed(conditions: dict, old: str, new: str) -> dict:
    return {
        **conditions,
        "rules": [
            {**rule, "value": new} if _cites_label(rule, old) else rule
            for rule in _label_rules(conditions)
        ],
    }


def rename_label_in_conditions(salon, old: str, new: str) -> tuple[int, int]:
    """Riscrive il nome dell'etichetta nelle condizioni che la citano.

    Rinominare «Da seguire» in «Da seguire!» spegneva in silenzio la regola
    «SE etichetta = Da seguire → caparra 20 €»: alle clienti a rischio non si
    chiedeva più la caparra, e i filtri delle automazioni smettevano di
    scattare (06-06, 01-13, 15-07). Le automazioni aggiornate si rimandano a
    Yourang, che le esegue con le condizioni che ha ricevuto.
    """
    rules, automations = rules_citing_label(salon, old)
    for rule in rules:
        rule.conditions = _renamed(rule.conditions, old, new)
        rule.save(update_fields=["conditions", "updated_at"])
    if automations:
        # lazy: la definizione e il suo invio sono delle automazioni
        from apps.automations.services import definition, publish_definition

        for automation in automations:
            automation.conditions = _renamed(automation.conditions, old, new)
            automation.save(update_fields=["conditions", "updated_at"])
            publish_definition(salon, definition(automation))
    return len(rules), len(automations)


def create_label(ctx, payload: dict) -> ClientCategory:
    """Crea l'etichetta dal corpo già controllato da `label_payload`."""
    try:
        with transaction.atomic():
            category = ClientCategory.objects.create(salon=ctx.salon, **payload)
    except IntegrityError:
        # Due «Salva» nello stesso istante: il controllo di `label_payload` non è atomico.
        raise HttpError(400, DUPLICATE_LABEL)
    log_activity(
        ctx.salon,
        "client_category.created",
        f"Etichetta creata: {category.name}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


def update_label(ctx, category: ClientCategory, payload: dict) -> ClientCategory:
    """Applica il corpo già controllato; se il nome cambia, lo riscrive nelle condizioni.

    Tutto nella stessa transazione: etichetta, regole caparra, automazioni e
    registro attività, dopo lo stesso lock di `delete_label` (il salone, poi la
    riga dell'etichetta, riletta). Si salvava con save() completo la copia letta
    a inizio richiesta: in gara con una cancellazione la riga non c'era più e
    Django la reinseriva, e l'etichetta tornava senza più le sue clienti; e il
    nome da riscrivere nelle condizioni era quello di prima di un rinomina
    fatto nel frattempo. Ora si scrivono solo le colonne del corpo, sulla riga
    di adesso; se è stata eliminata, 404. Il lock del salone è quello di chi
    salva regole caparra e automazioni: il rinomina ne riscrive le condizioni.
    """
    from apps.agenda.services.locking import lock_salon  # lazy

    with transaction.atomic():
        lock_salon(ctx.salon)
        category = ClientCategory.objects.select_for_update().filter(pk=category.pk).first()
        if category is None:
            raise HttpError(404, "Etichetta non trovata")
        old_name = category.name
        for name, value in payload.items():
            setattr(category, name, value)
        try:
            with transaction.atomic():
                category.save(update_fields=list(payload))
        except IntegrityError:
            raise HttpError(400, DUPLICATE_LABEL)
        rules = automations = 0
        if category.name != old_name:
            rules, automations = rename_label_in_conditions(ctx.salon, old_name, category.name)
        summary = (
            f"Etichetta rinominata: {old_name} → {category.name}"
            if category.name != old_name
            else f"Etichetta aggiornata: {category.name}"
        )
        if rules or automations:
            summary += f" (condizioni aggiornate: {rules} regole caparra, {automations} automazioni)"
        log_activity(
            ctx.salon,
            "client_category.updated",
            summary,
            actor=ctx.user,
            payload={"category_id": category.id},
        )
    return category


def delete_label(ctx, category: ClientCategory) -> None:
    """Elimina l'etichetta, se nessuna regola caparra o automazione la cita.

    Controllo e cancellazione stanno nella stessa transazione, dopo il lock del
    salone e poi della riga dell'etichetta (l'ordine salone → riga di
    `agenda.services.locking`). Erano due passi separati: una regola salvata
    da un'altra postazione fra i due citava un'etichetta che non c'era più, e
    non scattava per nessuna senza avviso (voce 26 dei bug sospetti del
    24/09). Perché il controllo veda sempre la regola salvata nel frattempo,
    chi salva regole caparra e automazioni deve prendere lo stesso lock.
    """
    from apps.agenda.services.locking import lock_salon  # lazy

    category_id = category.id  # dopo delete() l'istanza non ha più il suo id
    with transaction.atomic():
        lock_salon(ctx.salon)
        # Riletta dopo il lock: rinominata nel frattempo, le regole la citano
        # con il nome nuovo, e il controllo va fatto su quello.
        category = ClientCategory.objects.select_for_update().filter(pk=category_id).first()
        if category is None:
            raise HttpError(404, "Etichetta non trovata")
        name = category.name
        # Eliminata l'etichetta, la regola che la cita non scatta più per nessuna,
        # senza che niente lo dica — lo stesso silenzio del rinomina. Togliere la
        # condizione al posto del titolare sarebbe peggio: in una regola «E» il
        # resto varrebbe per tutte le clienti. Prima si sistemano le regole.
        rules, automations = rules_citing_label(ctx.salon, name)
        if rules or automations:
            used_by = [f"regola caparra «{r.name}»" for r in rules] + [
                f"automazione «{a.name}»" for a in automations
            ]
            more = f" e altre {len(used_by) - 3}" if len(used_by) > 3 else ""
            raise HttpError(
                400,
                f"L'etichetta «{name}» è usata da {', '.join(used_by[:3])}{more}: "
                "togli la condizione da lì, poi eliminala.",
            )
        category.delete()
        log_activity(
            ctx.salon,
            "client_category.deleted",
            f"Etichetta eliminata: {name}",
            actor=ctx.user,
            payload={"category_id": category_id},
        )


def label_counts(salon) -> dict:
    """Schede attive del salone, in tutto e per etichetta (anche a zero): {active, categories}.

    Sono i numeri delle card in cima alla sezione Clienti, che la dashboard
    ricavava da una lista `limit=1` per «Attivi» e una per ogni etichetta, a
    ogni evento del feed dal vivo: 1+N richieste su ogni postazione aperta
    (voce 43 dei bug sospetti del 24/09). Qui gli stessi conteggi della lista
    con `is_active=true` (e `category_id`), in due query.
    """
    categories = ClientCategory.objects.filter(salon=salon).annotate(
        active_clients=Count(
            "clients", filter=Q(clients__salon=salon, clients__is_active=True), distinct=True
        )
    )
    return {
        "active": Client.objects.filter(salon=salon, is_active=True).count(),
        "categories": [{"id": c.id, "count": c.active_clients} for c in categories],
    }


# ---- Etichette di una scheda --------------------------------------------------


def set_categories(client: Client, category_ids: list[int]) -> bool:
    """Etichette della scheda = quelle indicate (del salone). True se sono cambiate."""
    categories = list(ClientCategory.objects.filter(salon=client.salon_id, id__in=category_ids))
    before = set(client.categories.values_list("id", flat=True))
    client.categories.set(categories)
    return before != {c.id for c in categories}
