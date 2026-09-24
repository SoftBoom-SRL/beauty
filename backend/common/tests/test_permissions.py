"""`has_scope` e `require_scope` (common/permissions.py).

`has_scope` prende il posto delle copie a mano di «titolare, oppure ha il
permesso»: clients/api.py (`may_see`, `can_read_sales`), staff/api.py
(`_sees_cash`, `_sees_hourly_cost`), inventory/schemas.py
(`resolve_invoice_url`), automations/api.py (`list_automations`). Qui si
controlla che risponda come l'espressione copiata, in ogni combinazione.
"""

from types import SimpleNamespace

from django.test import SimpleTestCase
from ninja.errors import HttpError

from common.permissions import SCOPES, has_scope, require_scope
from common.testing import staff_context


def _copied_rule(ctx, scope):
    # L'espressione delle copie al commit 4ecefc8, per confronto.
    return ctx.is_owner or scope in ctx.scopes


class HasScopeTests(SimpleTestCase):
    def test_owner_has_every_scope_even_without_a_role(self):
        ctx = staff_context(None, (), is_owner=True)
        for scope in SCOPES:
            self.assertIs(has_scope(ctx, scope), True)

    def test_member_has_only_the_scopes_of_the_role(self):
        ctx = staff_context(None, ("agenda", "sales"))
        self.assertIs(has_scope(ctx, "sales"), True)
        self.assertIs(has_scope(ctx, "agenda"), True)
        self.assertIs(has_scope(ctx, "team"), False)
        self.assertIs(has_scope(ctx, "marketing"), False)

    def test_same_answer_as_the_copies(self):
        for is_owner in (False, True):
            for scopes in ((), ("sales",), ("marketing", "team"), tuple(SCOPES)):
                ctx = staff_context(None, scopes, is_owner=is_owner)
                for scope in [*SCOPES, "inesistente", ""]:
                    self.assertEqual(
                        has_scope(ctx, scope), _copied_rule(ctx, scope), (is_owner, scopes, scope)
                    )

    def test_scopes_are_not_read_for_the_owner(self):
        # Come nelle copie: `or` si ferma al titolare, `scopes` non serve.
        self.assertIs(has_scope(SimpleNamespace(is_owner=True), "sales"), True)

    def test_scopes_as_a_list_work_like_a_set(self):
        ctx = SimpleNamespace(is_owner=False, scopes=["sales"])
        self.assertIs(has_scope(ctx, "sales"), True)
        self.assertIs(has_scope(ctx, "team"), False)


class RequireScopeTests(SimpleTestCase):
    def test_missing_scope_is_a_403_naming_the_scope(self):
        with self.assertRaises(HttpError) as caught:
            require_scope(staff_context(None, ("agenda",)), "sales")
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.message, "Permesso mancante: sales")

    def test_granted_scope_passes(self):
        self.assertIsNone(require_scope(staff_context(None, ("sales",)), "sales"))

    def test_owner_passes_without_the_scope(self):
        self.assertIsNone(require_scope(staff_context(None, (), is_owner=True), "team"))

    def test_same_outcome_as_has_scope(self):
        for is_owner in (False, True):
            for scopes in ((), ("sales",), tuple(SCOPES)):
                ctx = staff_context(None, scopes, is_owner=is_owner)
                for scope in SCOPES:
                    if has_scope(ctx, scope):
                        self.assertIsNone(require_scope(ctx, scope))
                    else:
                        with self.assertRaises(HttpError):
                            require_scope(ctx, scope)
