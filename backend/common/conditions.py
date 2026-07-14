"""Valutatore di condizioni combinabili con E/O.

Formato JSON condiviso da regole deposito (core.DepositRule) e filtri
delle automazioni (automations.Automation):

    {"op": "and" | "or",
     "rules": [{"field": "reliability", "cmp": "lt", "value": 60}, ...]}

`facts` è un dict piatto costruito dal chiamante
(es. apps.clients.services.client_facts).
Condizioni vuote/None ⇒ True. Campo assente nei facts ⇒ regola False.
"""

_CMP = {
    "eq": lambda a, b: a == b,
    "neq": lambda a, b: a != b,
    "lt": lambda a, b: a < b,
    "lte": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "gte": lambda a, b: a >= b,
    # contains: b dentro a (lista o stringa, case-insensitive per stringhe)
    "contains": lambda a, b: (
        b.lower() in [x.lower() for x in a]
        if isinstance(a, list) and all(isinstance(x, str) for x in a)
        else (b in a)
    ),
}


def _rule(rule: dict, facts: dict) -> bool:
    field = rule.get("field")
    if field not in facts:
        return False
    cmp_fn = _CMP.get(rule.get("cmp", "eq"))
    if cmp_fn is None:
        return False
    try:
        return bool(cmp_fn(facts[field], rule.get("value")))
    except TypeError:
        return False


def evaluate(conditions: dict | None, facts: dict) -> bool:
    if not conditions or not conditions.get("rules"):
        return True
    results = (_rule(r, facts) for r in conditions["rules"])
    if conditions.get("op", "and") == "or":
        return any(results)
    return all(results)
