"""Aggiuntivi: le voci senza tempo che si appoggiano al servizio prima di loro.

Nei saloni di unghie molti trattamenti si fanno DENTRO il tempo di un altro: la
nail art durante la manicure, la rimozione del gel prima del colore, il
massaggio ai piedi durante la pedicure. Nel listino sono servizi con
`is_addon`; nella visita la loro voce dura 0 minuti, senza posa. Aggiunge il
prezzo (al conto, alla caparra, al margine) ma non il tempo, e non occupa
nessuno slot. Prima ogni servizio allungava l'appuntamento: manicure 30' più
nail art 15' teneva la cliente tre quarti d'ora, e la colonna di Giulia
risultava occupata per un quarto d'ora in cui Giulia era libera.

Le regole, le stesse in creazione, modifica, ricerca degli orari, conferma,
spostamento, stacco e «torna indietro»:

- una voce è un aggiuntivo quando non ha tempo (`duration_min` e `soak_min` a
  0). Le voci nuove lo sono se il loro servizio è un aggiuntivo; quelle già
  sulla visita restano come sono state concordate (vedi
  `resolution.resolve_items_edit`): la nail art prenotata a 15' prima che il
  salone la segnasse come aggiuntivo non si accorcia da sola alla prima
  modifica della visita;
- un aggiuntivo si appoggia al servizio PRIMA di lui nella catena: non può
  essere la prima voce, e una visita non può essere fatta di soli aggiuntivi
  (422, mai superabile forzando: non è una questione di orario);
- lo fa chi fa il servizio a cui si appoggia, se lo sa fare, altrimenti la
  prima idonea (`addon_operator`). Non occupa tempo, quindi non c'è libertà da
  verificare né turno da rispettare;
- si stacca insieme al suo servizio, mai da solo (`with_addons` e
  `appointments.split_appointment`).
"""

from ninja.errors import HttpError

ADDON_ALONE_MESSAGE = "Un aggiuntivo va insieme a un servizio"
ADDON_FIRST_MESSAGE = "Un aggiuntivo va dopo il servizio a cui si appoggia"
ADDON_SPLIT_MESSAGE = "Un aggiuntivo non si stacca da solo: stacca il servizio a cui si appoggia"


def is_timeless(duration_min, soak_min) -> bool:
    """Vero per una voce senza tempo, cioè un aggiuntivo: né lavoro né posa."""
    return not duration_min and not soak_min


def check_chain(addon_flags) -> None:
    """422 se la catena è fatta di soli aggiuntivi o comincia con uno.

    `addon_flags`: per ogni voce, in ordine, se è un aggiuntivo. Si chiama a
    servizi già risolti (404 e 400 prima) e prima di guardare gli orari (409
    dopo): il banco riprova forzando solo i 409, e questo non lo è.
    """
    flags = list(addon_flags)
    if flags and all(flags):
        raise HttpError(422, ADDON_ALONE_MESSAGE)
    if flags and flags[0]:
        raise HttpError(422, ADDON_FIRST_MESSAGE)


def addon_operator(eligible, parent):
    """Chi fa un aggiuntivo per cui non è stata indicata nessuna.

    L'operatrice del servizio a cui si appoggia (`parent`), se fra le idonee:
    la nail art la fa chi sta facendo la manicure. Altrimenti la prima idonea,
    senza guardare se è libera: l'aggiuntivo non le prende tempo. None se non
    ce n'è nessuna (chi chiama ha già risposto 400 in quel caso).
    """
    if parent is not None:
        same = next((op for op in eligible if op.id == parent.id), None)
        if same is not None:
            return same
    return eligible[0] if eligible else None


def with_addons(items: list, item) -> list:
    """La voce `item` con gli aggiuntivi che le vengono subito dietro, in ordine.

    `items` sono le righe della visita in ordine di catena. È il «pezzo» che si
    stacca: la manicure con la sua nail art. Va chiamata su una voce con tempo:
    un aggiuntivo da solo non si stacca (`ADDON_SPLIT_MESSAGE`).
    """
    index = items.index(item)
    group = [item]
    for following in items[index + 1:]:
        if not is_timeless(following.duration_min, following.soak_min):
            break
        group.append(following)
    return group
