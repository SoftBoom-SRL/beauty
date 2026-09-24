"""Lock delle scritture in agenda: prima il salone, poi la riga dell'appuntamento.

Chiunque scriva sull'agenda (qui, la cassa, il webhook Stripe, il rilascio delle
caparre, «torna indietro») prende i lock in quest'ordine: vedi `lock_salon` e
`_lock_row`.
"""

from ninja.errors import HttpError

from ..models import Appointment


def lock_salon(salon) -> None:
    """Serializza le scritture in agenda del salone dentro la transazione corrente.

    «Controllo che lo slot sia libero» e «inserisco» non sono atomici di per sé:
    su PostgreSQL due richieste simultanee potevano superare entrambe la
    verifica prima che una delle due fosse visibile all'altra, e finire
    sovrapposte. Il lock sulla riga del salone (SELECT … FOR NO KEY UPDATE)
    fa attendere la seconda finché la prima non ha committato. Su SQLite è un
    no-op, ma lì le scritture sono già seriali. Va chiamata DENTRO atomic().

    Il lock è FOR NO KEY UPDATE, non FOR UPDATE. Su PostgreSQL le chiavi
    esterne di Django sono DEFERRABLE INITIALLY DEFERRED: al COMMIT chi ha
    inserito righe legate al salone (vendite, registro attività, eventi
    outbox) ne verifica l'esistenza con FOR KEY SHARE sulla riga del salone,
    incompatibile con FOR UPDATE. Un checkout che teneva la riga di un
    appuntamento restava così in attesa del salone al commit, mentre chi
    teneva il salone aspettava quella stessa riga: deadlock, e un 500 a una
    delle due. NO KEY UPDATE non ferma quei controlli e continua a
    serializzare fra loro tutte le chiamate a questa funzione. L'ordine resta
    sempre salone → riga dell'appuntamento (vedi `_lock_and_reload`).
    """
    from apps.core.models import Salon  # lazy

    list(
        Salon.objects.select_for_update(no_key=True)
        .filter(pk=salon.pk)
        .values_list("id", flat=True)
    )


def _ensure_open(appointment: Appointment) -> None:
    if appointment.status not in Appointment.OPEN_STATUSES:
        raise HttpError(400, "Appuntamento non modificabile nello stato attuale")


def _lock_and_reload(appointment: Appointment) -> None:
    """Prende il lock del salone e RILEGGE l'appuntamento dentro la transazione.

    L'istanza arriva qui caricata quando la richiesta è entrata: nel frattempo
    un'altra postazione può averla annullata. Decidendo sullo stato vecchio, lo
    spostamento passava il controllo e il save() successivo riscriveva anche
    `status`, riportando in agenda un appuntamento annullato. La rilettura
    avviene DOPO il lock, altrimenti si rileggerebbe di nuovo un dato che può
    cambiare un istante dopo.

    Dopo il salone si blocca anche la RIGA dell'appuntamento. Il webhook della
    caparra e il rilascio automatico lavorano sulla riga: col solo lock del
    salone un annullamento poteva rileggere «caparra richiesta» un istante
    prima che il pagamento fosse registrato e poi riscriverla sopra, o uno
    spostamento passare su una visita appena liberata. Sempre in quest'ordine
    (salone, poi riga), lo stesso di chi tocca l'appuntamento da cassa e Stripe.
    """
    _lock_row(appointment)
    _ensure_open(appointment)


def _lock_row(appointment: Appointment) -> None:
    """Lock del salone, poi lock e rilettura della riga dell'appuntamento."""
    lock_salon(appointment.salon)
    try:
        appointment.refresh_from_db(from_queryset=Appointment.objects.select_for_update())
    except Appointment.DoesNotExist:
        raise HttpError(404, "Appuntamento non trovato")
