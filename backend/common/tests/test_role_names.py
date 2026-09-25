"""Nei test i ruoli fatti a mano non si chiamano come quelli di sistema.

«Manager», «Front desk» e «Operatrice» sono i ruoli che ogni salone riceve alla
nascita (`accounts.services.DEFAULT_ROLES`) e il nome di un ruolo è unico nel
salone. Un test che crea un «Manager» con la sola agenda passa solo perché i
saloni di prova nascono senza ruoli di sistema: se una base passasse da
`create_salon_foundation` si romperebbe con un IntegrityError, e chi lo legge
crede di provare il ruolo vero. Fanno eccezione i test dei ruoli di sistema
(`accounts/tests/test_team.py`), che quei nomi li usano apposta.
"""

import ast
import pathlib

from django.test import SimpleTestCase

from apps.accounts.services import DEFAULT_ROLES

BACKEND = pathlib.Path(__file__).resolve().parents[2]
SYSTEM_NAMES = {name for name, _scopes in DEFAULT_ROLES}
ALLOWED = {BACKEND / "apps" / "accounts" / "tests" / "test_team.py"}


def roles_named_like_system_ones() -> list[str]:
    found = []
    for path in sorted((BACKEND / "apps").glob("*/tests/*.py")):
        if path in ALLOWED:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), str(path))):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            target = node.func.value
            is_role_manager = (
                isinstance(target, ast.Attribute) and target.attr == "objects"
                and isinstance(target.value, ast.Name) and target.value.id == "Role"
            )
            if not is_role_manager or node.func.attr not in ("create", "get_or_create"):
                continue
            for keyword in node.keywords:
                if (
                    keyword.arg == "name" and isinstance(keyword.value, ast.Constant)
                    and keyword.value.value in SYSTEM_NAMES
                ):
                    found.append(f"{path.relative_to(BACKEND)}:{node.lineno}: «{keyword.value.value}»")
    return found


class TestRoleNamesTests(SimpleTestCase):
    def test_no_test_role_is_named_like_a_system_role(self):
        found = roles_named_like_system_ones()
        self.assertEqual(found, [], "\n".join(found))
