"""`merge_intervals` (common/intervals.py) contro le quattro copie che sostituisce.

Al commit 4ecefc8 le copie (staff/services.py `_merge_windows`; agenda/services.py
`_opening_bands`, `_merge_spans` e il ciclo in `_slot_is_recommended`) erano lo
stesso codice con nomi diversi: qui ce n'è una trascritta com'era, e il confronto
gira su casi a caso oltre che sui bordi.
"""

import datetime as dt
import random

from django.test import SimpleTestCase

from common.intervals import merge_intervals


def _copied_merge(windows):
    # staff/services.py `_merge_windows` al commit 4ecefc8, com'era.
    merged: list[tuple[int, int]] = []
    for start, end in sorted(windows):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


class MergeIntervalsTests(SimpleTestCase):
    def test_touching_intervals_become_one(self):
        self.assertEqual(merge_intervals([(540, 780), (780, 1080)]), [(540, 1080)])

    def test_overlapping_and_contained_intervals_become_one(self):
        self.assertEqual(merge_intervals([(9, 13), (12, 15), (10, 11)]), [(9, 15)])

    def test_separate_intervals_stay_separate_and_sorted(self):
        self.assertEqual(merge_intervals([(20, 21), (9, 13), (14, 18)]), [(9, 13), (14, 18), (20, 21)])

    def test_empty_input(self):
        self.assertEqual(merge_intervals([]), [])

    def test_duplicates_collapse(self):
        self.assertEqual(merge_intervals([(9, 13), (9, 13)]), [(9, 13)])

    def test_same_start_keeps_the_longest(self):
        self.assertEqual(merge_intervals([(9, 18), (9, 13)]), [(9, 18)])

    def test_lists_in_tuples_out_and_input_untouched(self):
        rows = [[14, 18], [9, 13], [13, 14]]
        self.assertEqual(merge_intervals(rows), [(9, 18)])
        self.assertEqual(rows, [[14, 18], [9, 13], [13, 14]])
        self.assertEqual(merge_intervals([[9, 10]]), [(9, 10)])
        self.assertIsInstance(merge_intervals([[9, 10]])[0], tuple)

    def test_any_iterable(self):
        self.assertEqual(merge_intervals(iter([(3, 4), (1, 3)])), [(1, 4)])

    def test_datetimes(self):
        # `_merge_spans` lavora su istanti, non su minuti.
        t = dt.datetime(2026, 9, 24, 9, tzinfo=dt.timezone.utc)
        h = dt.timedelta(hours=1)
        self.assertEqual(
            merge_intervals([(t + 2 * h, t + 3 * h), (t, t + h), (t + h, t + 2 * h)]),
            [(t, t + 3 * h)],
        )

    def test_zero_length_interval_on_a_border_is_absorbed(self):
        self.assertEqual(merge_intervals([(9, 13), (13, 13)]), [(9, 13)])
        self.assertEqual(merge_intervals([(13, 13), (13, 18)]), [(13, 18)])

    def test_same_result_as_the_copies_on_random_input(self):
        rng = random.Random(20260924)
        for _ in range(500):
            rows = []
            for _ in range(rng.randint(0, 8)):
                start = rng.randint(0, 40)
                rows.append((start, start + rng.randint(0, 10)))
            self.assertEqual(merge_intervals(rows), _copied_merge(rows), rows)
