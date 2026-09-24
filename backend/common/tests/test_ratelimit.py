"""`enforce` e `enforce_public` (common/ratelimit.py) contro i blocchi scritti a mano.

`enforce_public` sostituisce il tetto per IP degli endpoint pubblici di
catalog/api.py (`_public_ratelimit`), staff/api.py (`public_operators`) e
agenda/api.py (`public_availability`); `enforce` la forma
`if not ratelimit.hit(...): raise HttpError(429, ...)`.
"""

from datetime import timedelta

from django.test import RequestFactory, TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import RateLimitCounter, Salon
from common import ratelimit

MESSAGE = "Troppe richieste: riprova tra qualche minuto"


def _copied_public_limit(request, salon, bucket, limit, window_seconds):
    # catalog/api.py `_public_ratelimit` al commit 4ecefc8, con tetto e
    # finestra come argomenti (staff e agenda cambiano solo quelli e il bucket).
    if not ratelimit.hit(
        f"public-{bucket}:{salon.id}:{ratelimit.client_ip(request)}",
        limit,
        window_seconds,
    ):
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")


def _outcome(fn, *args):
    try:
        fn(*args)
    except HttpError as exc:
        return (exc.status_code, exc.message)
    return None


class EnforceTests(TestCase):
    def test_under_the_limit_passes_and_counts(self):
        for n in (1, 2, 3):
            self.assertIsNone(ratelimit.enforce("prova", 3, 60, "Basta"))
            self.assertEqual(ratelimit.peek("prova"), n)

    def test_over_the_limit_is_a_429_with_the_message(self):
        for _ in range(2):
            ratelimit.enforce("prova", 2, 60, "Troppe attivazioni: riprova tra qualche minuto")
        with self.assertRaises(HttpError) as caught:
            ratelimit.enforce("prova", 2, 60, "Troppe attivazioni: riprova tra qualche minuto")
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.message, "Troppe attivazioni: riprova tra qualche minuto")
        # Come con `hit`: anche il tentativo rifiutato si conta.
        self.assertEqual(ratelimit.peek("prova"), 3)

    def test_window_is_the_one_asked(self):
        before = timezone.now()
        ratelimit.enforce("finestra", 5, 3600, "Basta")
        after = timezone.now()
        expires = RateLimitCounter.objects.get(key="finestra").expires_at
        self.assertTrue(before + timedelta(seconds=3600) <= expires <= after + timedelta(seconds=3600))

    def test_same_outcomes_as_hit_then_raise(self):
        def copied(key, limit, window, message):
            if not ratelimit.hit(key, limit, window):
                raise HttpError(429, message)

        got = [_outcome(ratelimit.enforce, "nuovo", 3, 60, "Basta") for _ in range(5)]
        want = [_outcome(copied, "vecchio", 3, 60, "Basta") for _ in range(5)]
        self.assertEqual(got, want)
        self.assertEqual(ratelimit.peek("nuovo"), ratelimit.peek("vecchio"))


class EnforcePublicTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.salon = Salon.objects.create(name="Salone A", slug="salone-a")
        cls.other = Salon.objects.create(name="Salone B", slug="salone-b")

    def _request(self, **meta):
        return RequestFactory().get("/api/catalog/public/services", **meta)

    def test_key_is_bucket_salon_and_ip(self):
        ratelimit.enforce_public(self._request(REMOTE_ADDR="203.0.113.5"), self.salon, "services", 120, 300)
        self.assertEqual(
            list(RateLimitCounter.objects.values_list("key", "count")),
            [(f"public-services:{self.salon.id}:203.0.113.5", 1)],
        )

    def test_over_the_limit_is_the_429_of_the_copies(self):
        request = self._request(REMOTE_ADDR="203.0.113.5")
        for _ in range(2):
            ratelimit.enforce_public(request, self.salon, "avail", 2, 3600)
        with self.assertRaises(HttpError) as caught:
            ratelimit.enforce_public(request, self.salon, "avail", 2, 3600)
        self.assertEqual((caught.exception.status_code, caught.exception.message), (429, MESSAGE))

    def test_buckets_salons_and_ips_count_apart(self):
        ratelimit.enforce_public(self._request(REMOTE_ADDR="203.0.113.5"), self.salon, "services", 1, 300)
        ratelimit.enforce_public(self._request(REMOTE_ADDR="203.0.113.5"), self.salon, "packages", 1, 300)
        ratelimit.enforce_public(self._request(REMOTE_ADDR="203.0.113.5"), self.other, "services", 1, 300)
        ratelimit.enforce_public(self._request(REMOTE_ADDR="203.0.113.6"), self.salon, "services", 1, 300)
        self.assertEqual(RateLimitCounter.objects.count(), 4)
        self.assertEqual(set(RateLimitCounter.objects.values_list("count", flat=True)), {1})

    def test_ip_comes_from_client_ip(self):
        # Dal proxy (rete interna) vale l'ultimo elemento di X-Forwarded-For;
        # da fuori l'header non conta; senza indirizzo, "unknown".
        cases = [
            ({"REMOTE_ADDR": "10.0.0.2", "HTTP_X_FORWARDED_FOR": "198.51.100.1, 203.0.113.9"}, "203.0.113.9"),
            ({"REMOTE_ADDR": "203.0.113.5", "HTTP_X_FORWARDED_FOR": "198.51.100.1"}, "203.0.113.5"),
            ({"REMOTE_ADDR": ""}, "unknown"),
        ]
        for meta, ip in cases:
            with self.subTest(meta=meta):
                request = self._request(**meta)
                self.assertEqual(ratelimit.client_ip(request), ip)
                ratelimit.enforce_public(request, self.salon, "operators", 120, 300)
                self.assertEqual(ratelimit.peek(f"public-operators:{self.salon.id}:{ip}"), 1)

    def test_same_outcomes_and_counters_as_the_copies(self):
        # Stesse chiamate, una volta con la copia e una con l'aiuto, su due
        # saloni diversi: stessi esiti chiamata per chiamata, stessi contatori.
        for bucket, limit, window in (("services", 3, 300), ("operators", 2, 300), ("avail", 1, 3600)):
            with self.subTest(bucket=bucket):
                request = self._request(REMOTE_ADDR="203.0.113.7")
                want = [_outcome(_copied_public_limit, request, self.other, bucket, limit, window) for _ in range(4)]
                got = [_outcome(ratelimit.enforce_public, request, self.salon, bucket, limit, window) for _ in range(4)]
                self.assertEqual(got, want)
                self.assertEqual(
                    ratelimit.peek(f"public-{bucket}:{self.salon.id}:203.0.113.7"),
                    ratelimit.peek(f"public-{bucket}:{self.other.id}:203.0.113.7"),
                )
