"""Contatore dei limiti di frequenza: common.ratelimit su core.RateLimitCounter."""

from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone


class RateLimitCounterTests(TestCase):
    """Il contatore dei limiti deve contare davvero, e per il tempo richiesto.

    Prima si appoggiava alla cache su database: `incr()` lì è una lettura
    seguita da una scrittura (due richieste parallele contavano per una) e la
    scrittura riportava la scadenza al valore predefinito, 300 secondi, qualsiasi
    finestra fosse stata chiesta.
    """

    def setUp(self):
        from common import ratelimit

        self.ratelimit = ratelimit

    def test_the_window_lasts_exactly_what_was_asked(self):
        from ..models import RateLimitCounter

        before = timezone.now()
        self.ratelimit.hit("finestra", 5, 3600)
        row = RateLimitCounter.objects.get(key="finestra")
        self.assertGreater((row.expires_at - before).total_seconds(), 3590)

    def test_the_limit_stops_at_the_declared_number(self):
        results = [self.ratelimit.hit("tetto", 3, 3600) for _ in range(5)]
        self.assertEqual(results, [True, True, True, False, False])
        self.assertEqual(self.ratelimit.peek("tetto"), 5)

    def test_two_overlapping_requests_count_twice(self):
        # Si riproduce l'intreccio fra due processi: la seconda richiesta entra
        # mentre la prima sta ancora decidendo. L'incremento è una sola UPDATE
        # del database, quindi nessuno dei due conteggi va perso.
        from ..models import RateLimitCounter

        self.ratelimit.hit("gara", 1, 3600)
        original = RateLimitCounter.objects.filter

        nested = []

        def interleaved(*args, **kwargs):
            qs = original(*args, **kwargs)
            if not nested:
                nested.append(None)
                self.ratelimit.hit("gara", 1, 3600)
            return qs

        with patch.object(RateLimitCounter.objects, "filter", side_effect=interleaved):
            self.ratelimit.hit("gara", 1, 3600)
        self.assertEqual(self.ratelimit.peek("gara"), 3)

    def test_an_expired_window_starts_over(self):
        from datetime import timedelta

        from ..models import RateLimitCounter

        self.assertFalse(self.ratelimit.hit("scaduta", 0, 3600))
        RateLimitCounter.objects.filter(key="scaduta").update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertTrue(self.ratelimit.hit("scaduta", 1, 3600))
        self.assertEqual(self.ratelimit.peek("scaduta"), 1)

    def test_purge_removes_only_the_expired_windows(self):
        from datetime import timedelta

        from ..models import RateLimitCounter

        self.ratelimit.hit("viva", 5, 3600)
        self.ratelimit.hit("morta", 5, 3600)
        RateLimitCounter.objects.filter(key="morta").update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.ratelimit.purge_expired()
        self.assertEqual(
            list(RateLimitCounter.objects.values_list("key", flat=True)), ["viva"]
        )
