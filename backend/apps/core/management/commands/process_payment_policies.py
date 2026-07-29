"""Applica le policy di pagamento dei saloni. Da schedulare via cron (ogni 5-15').

    python manage.py process_payment_policies            # tutti i saloni
    python manage.py process_payment_policies --salon 3   # un solo salone
    python manage.py process_payment_policies --dry-run   # mostra e non tocca

Due automatismi DISTINTI, con tempi distinti e configurabili per salone
(non tutti i saloni hanno le stesse esigenze):

  PRIMA dell'appuntamento — scadenza caparra (`deposit_deadline_hours`)
      caparra ancora non pagata a meno di N ore dall'inizio →
        none   : nessuna azione (l'evento in outbox permette a Yourang di sollecitare)
        charge : la incassa sulla carta già salvata, se c'è
        cancel : annulla e libera lo slot

  DOPO l'inizio — mancata presentazione (`noshow_charge_mode=automatic`)
      appuntamento mai passato in check-in, N minuti dopo l'inizio →
      marcato no-show e addebitata la percentuale prevista.

Stesse convenzioni di flush_outbox/sync_yourang: nessuno scheduler in-process,
il tempo lo dà il cron.
"""

import datetime as dt

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.core.models import SalonSettings
from apps.core.services import emit_event, log_activity

# Quanto indietro può guardare il no-show automatico, oltre il ritardo impostato
# dal salone. Fa da rete di sicurezza: permette al cron di recuperare un fermo di
# un giorno, ma impedisce di addebitare in blocco arretrati vecchi.
LOOKBACK_GRACE_HOURS = 24


def _label(appt) -> str:
    """Etichetta leggibile nell'ORA DEL SALONE.

    `appt.start` è in UTC: formattarlo direttamente farebbe leggere al salone
    orari sfasati nel log del cron (stesso equivoco già corretto nel frontend).
    """
    return f"{appt.client.full_name} · {timezone.localtime(appt.start):%d/%m %H:%M}"


class Command(BaseCommand):
    help = "Applica le policy di pagamento (scadenza caparra, no-show automatico)"

    def add_arguments(self, parser):
        parser.add_argument("--salon", type=int, default=None, help="ID salone singolo")
        parser.add_argument("--dry-run", action="store_true", help="Non modifica nulla")

    def handle(self, *args, **options):
        self.dry = options["dry_run"]
        qs = SalonSettings.objects.select_related("salon")
        if options["salon"]:
            qs = qs.filter(salon_id=options["salon"])
        for st in qs:
            self._deposit_deadlines(st)
            self._auto_no_show(st)

    # -- PRIMA: scadenza caparra ---------------------------------------------

    def _deposit_deadlines(self, st: SalonSettings):
        from apps.agenda.models import Appointment

        if not st.deposit_enabled or not st.deposit_deadline_hours:
            return
        now = timezone.now()
        cutoff = now + dt.timedelta(hours=st.deposit_deadline_hours)
        due = Appointment.objects.select_related("client", "salon").filter(
            salon=st.salon,
            status=Appointment.Status.CONFIRMED,
            deposit_status=Appointment.DepositStatus.REQUIRED,
            start__gt=now,          # non ancora iniziati
            start__lte=cutoff,      # ma entro la finestra di scadenza
        )
        for appt in due:
            label = _label(appt)
            if self.dry:
                self.stdout.write(f"  [dry] caparra scaduta ({st.deposit_deadline_action}): {label}")
                continue
            # L'evento parte in ogni caso: è ciò che permette a Yourang di
            # sollecitare la cliente, anche quando non si addebita né si annulla.
            emit_event(st.salon, "deposit.deadline", {
                "appointment_id": appt.id,
                "client_name": appt.client.full_name,
                "phone": appt.client.phone,
                "lang": appt.client.lang,
                "amount": str(appt.deposit_amount),
                "start": appt.start.isoformat(),
                "action": st.deposit_deadline_action,
            })
            action = st.deposit_deadline_action
            if action == SalonSettings.DepositDeadlineAction.CHARGE:
                self._charge_deposit(appt, label)
            elif action == SalonSettings.DepositDeadlineAction.CANCEL:
                self._cancel_unpaid(appt, label)
            else:
                self.stdout.write(f"  avviso caparra scaduta: {label}")

    def _charge_deposit(self, appt, label):
        from apps.sales import stripe_service

        try:
            stripe_service.charge_deposit_off_session(appt)
        except stripe_service.ChargeAuthRequired:
            log_activity(appt.salon, "deposit.charge_pending",
                         f"Caparra da autenticare — {appt.client.full_name}",
                         payload={"appointment_id": appt.id})
            self.stdout.write(self.style.WARNING(f"  caparra da autenticare: {label}"))
            return
        except Exception as exc:  # noqa: BLE001 — carta assente, Stripe non collegato…
            log_activity(appt.salon, "deposit.charge_failed",
                         f"Caparra non incassata — {appt.client.full_name}",
                         payload={"appointment_id": appt.id, "error": str(exc)[:300]})
            self.stdout.write(self.style.ERROR(f"  caparra non incassata: {label} — {exc}"))
            return
        # Lo stato passa a 'paid' dal webhook payment_intent.succeeded (kind=deposit):
        # unica fonte di verità, così non divergono i due percorsi.
        self.stdout.write(self.style.SUCCESS(f"  caparra incassata: {label}"))

    def _cancel_unpaid(self, appt, label):
        from apps.agenda.services import cancel_appointment

        try:
            cancel_appointment(appt, reason="Caparra non versata entro la scadenza")
        except Exception as exc:  # noqa: BLE001
            self.stdout.write(self.style.ERROR(f"  annullo non riuscito: {label} — {exc}"))
            return
        self.stdout.write(self.style.SUCCESS(f"  annullato per caparra non versata: {label}"))

    # -- DOPO: no-show automatico -------------------------------------------

    def _auto_no_show(self, st: SalonSettings):
        from apps.agenda.models import Appointment
        from apps.agenda.services import mark_no_show

        if st.noshow_charge_mode != SalonSettings.NoShowMode.AUTOMATIC:
            return  # il salone preferisce decidere a mano
        now = timezone.now()
        threshold = now - dt.timedelta(minutes=st.noshow_charge_delay_min)
        # LIMITE INFERIORE OBBLIGATORIO. Un appuntamento esce da `confirmed` solo
        # se qualcuno fa check-in / incassa / annulla, e nella pratica i saloni se
        # ne dimenticano: senza questo limite, il giorno in cui un salone accende
        # la modalità automatica il comando marcherebbe no-show TUTTI gli
        # arretrati e li addebiterebbe in blocco. Idem se il cron resta fermo.
        # Oltre la finestra decide una persona, non l'automatismo.
        floor = threshold - dt.timedelta(hours=LOOKBACK_GRACE_HOURS)
        stale = Appointment.objects.select_related("client", "salon").filter(
            salon=st.salon,
            status=Appointment.Status.CONFIRMED,  # mai passato in check-in
            start__lte=threshold,
            start__gte=floor,
        )
        skipped = Appointment.objects.filter(
            salon=st.salon, status=Appointment.Status.CONFIRMED, start__lt=floor
        ).count()
        if skipped:
            # Mai in silenzio: un arretrato ignorato è una decisione, va detta.
            self.stdout.write(self.style.WARNING(
                f"  {skipped} appuntamenti oltre la finestra di {LOOKBACK_GRACE_HOURS}h "
                f"non toccati: vanno chiusi a mano"
            ))
        for appt in stale:
            label = _label(appt)
            if self.dry:
                self.stdout.write(f"  [dry] no-show automatico: {label}")
                continue
            try:
                mark_no_show(appt, reason="Mancata presentazione (automatico)")
            except Exception as exc:  # noqa: BLE001
                self.stdout.write(self.style.ERROR(f"  no-show non marcato: {label} — {exc}"))
                continue
            self.stdout.write(self.style.SUCCESS(f"  no-show marcato: {label}"))
            self._charge_no_show(appt, st.noshow_charge_pct, label)

    def _charge_no_show(self, appt, pct, label):
        from apps.sales import stripe_service

        if pct <= 0:
            return
        amount = stripe_service.pct_of(appt.total_price, pct)
        try:
            intent = stripe_service.charge_no_show(appt, pct=pct)
        except stripe_service.ChargeAuthRequired as exc:
            log_activity(appt.salon, "sale.no_show_charge_pending",
                         f"Addebito no-show € {amount} da autenticare — {appt.client.full_name}",
                         payload={"appointment_id": appt.id, "amount": str(amount),
                                  "payment_intent_id": exc.payment_intent_id})
            self.stdout.write(self.style.WARNING(f"    addebito da autenticare: {label}"))
            return
        except Exception as exc:  # noqa: BLE001
            log_activity(appt.salon, "sale.no_show_charge_failed",
                         f"Addebito no-show non riuscito — {appt.client.full_name}",
                         payload={"appointment_id": appt.id, "amount": str(amount),
                                  "error": str(exc)[:300]})
            self.stdout.write(self.style.ERROR(f"    addebito non riuscito: {label} — {exc}"))
            return
        log_activity(appt.salon, "sale.no_show_charged",
                     f"Addebito no-show € {amount} ({pct}%) — {appt.client.full_name}",
                     payload={"appointment_id": appt.id, "amount": str(amount), "pct": pct,
                              "payment_intent_id": intent["id"]})
        self.stdout.write(self.style.SUCCESS(f"    addebitato € {amount} ({pct}%): {label}"))
