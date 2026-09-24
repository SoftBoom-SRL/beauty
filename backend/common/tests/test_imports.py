"""Ogni `from … import nome` del progetto si risolve, anche quelli dentro le funzioni.

Molte funzioni di altre app si importano dentro la funzione che le usa (le
cercano a ogni chiamata, e i test le sostituiscono nel loro modulo). Un import
così non gira finché la funzione non viene chiamata: se il nome si sposta o
cambia, lint, avvio e test che non passano di lì restano verdi, e il 500 arriva
in produzione, sul primo rimborso o sul primo webhook. Il refactoring del 24/09
ha spostato centinaia di funzioni; questo test ferma la prossima che resta
indietro.
"""

import ast
import importlib
import pathlib

from django.test import SimpleTestCase

BACKEND = pathlib.Path(__file__).resolve().parents[2]
PACKAGES = ("apps", "common", "config")


def _module_name(path: pathlib.Path) -> list[str]:
    parts = list(path.relative_to(BACKEND).with_suffix("").parts)
    return parts[:-1] if parts[-1] == "__init__" else parts


def _target(path: pathlib.Path, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module
    parts = _module_name(path)
    # Da un __init__ il «.» è il package stesso; da un modulo è il package che lo contiene.
    keep = len(parts) - node.level + (1 if path.name == "__init__.py" else 0)
    return ".".join(parts[:keep] + ([node.module] if node.module else []))


def unresolved_imports() -> list[str]:
    problems = []
    for package in PACKAGES:
        for path in sorted((BACKEND / package).rglob("*.py")):
            if "migrations" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                target = _target(path, node)
                if not target.startswith(PACKAGES):
                    continue
                where = f"{path.relative_to(BACKEND)}:{node.lineno}"
                try:
                    module = importlib.import_module(target)
                except ImportError as exc:
                    problems.append(f"{where}: {target} non si importa ({exc})")
                    continue
                for alias in node.names:
                    if alias.name == "*" or hasattr(module, alias.name):
                        continue
                    try:  # `from pacchetto import sottomodulo`
                        importlib.import_module(f"{target}.{alias.name}")
                    except ImportError:
                        problems.append(f"{where}: {target} non ha «{alias.name}»")
    return problems


class ImportsResolveTests(SimpleTestCase):
    def test_every_import_of_the_project_resolves(self):
        problems = unresolved_imports()
        self.assertEqual(problems, [], "\n".join(problems))
