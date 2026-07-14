"""Anagrafica operatrici, pattern di turno (a cicli di N settimane), assenze.

Consumato da: agenda (`staff.services.shift_windows` per la disponibilità),
sales (`SaleLine.operator`), insights (occupancy via `shift_windows`).
FK verso altre app sempre a stringa.
"""

from django.db import models


class Operator(models.Model):
    """Operatrice del salone (può o non può avere un login staff associato)."""

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="operators")
    location = models.ForeignKey(
        "core.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="operators",
    )
    user = models.OneToOneField(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="operator_profile",
    )
    first_name = models.CharField(max_length=80)
    last_name = models.CharField(max_length=80)
    color = models.CharField(max_length=7, default="#A5B4FC")  # hex
    role_title = models.CharField(max_length=120, blank=True)
    services = models.ManyToManyField(
        "catalog.Service", blank=True, related_name="operators"
    )
    hourly_cost = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    cycle_weeks = models.PositiveSmallIntegerField(default=1)
    active = models.BooleanField(default=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "operatrice"
        verbose_name_plural = "operatrici"

    def __str__(self):
        return f"{self.first_name} {self.last_name}"

    @property
    def initials(self) -> str:
        parts = [p[0].upper() for p in (self.first_name, self.last_name) if p]
        return "".join(parts) or "?"


class WeeklyShift(models.Model):
    """Riga del pattern di turno ricorrente su un ciclo di `operator.cycle_weeks` settimane.

    Più righe con lo stesso (week_index, weekday) sono ammesse (es. turni spezzati);
    ciascuna può avere la propria pausa interna.
    """

    class Weekday(models.IntegerChoices):
        MONDAY = 0, "Lunedì"
        TUESDAY = 1, "Martedì"
        WEDNESDAY = 2, "Mercoledì"
        THURSDAY = 3, "Giovedì"
        FRIDAY = 4, "Venerdì"
        SATURDAY = 5, "Sabato"
        SUNDAY = 6, "Domenica"

    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name="shifts")
    week_index = models.PositiveSmallIntegerField(default=0)  # < operator.cycle_weeks
    weekday = models.PositiveSmallIntegerField(choices=Weekday.choices)
    start_min = models.PositiveSmallIntegerField()
    end_min = models.PositiveSmallIntegerField()
    break_start_min = models.PositiveSmallIntegerField(null=True, blank=True)
    break_end_min = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["week_index", "weekday", "start_min"]

    def __str__(self):
        return f"{self.operator} · w{self.week_index} · {self.get_weekday_display()}"


class Absence(models.Model):
    """Periodo di assenza (ferie, permesso, altro): annulla il turno nei giorni coperti."""

    class Type(models.TextChoices):
        VACATION = "vacation", "Ferie"
        HOLIDAY = "holiday", "Permesso"
        OTHER = "other", "Altro"

    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name="absences")
    date_from = models.DateField()
    date_to = models.DateField()
    type = models.CharField(max_length=10, choices=Type.choices)
    note = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["-date_from"]

    def __str__(self):
        return f"{self.operator} · {self.type} · {self.date_from}–{self.date_to}"
