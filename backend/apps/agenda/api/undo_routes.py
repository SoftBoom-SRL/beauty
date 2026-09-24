"""«Torna indietro» dalla dashboard: i gesti annullabili di chi chiede, e l'annullamento."""

from ninja import Router
from ninja.errors import HttpError

from common.auth import staff_auth
from common.permissions import require_scope

from .. import undo as undo_log
from ..presenters import _undo_out
from ..schemas import UndoIn, UndoOut, UndoResultOut

router = Router()


@router.get("/undo", auth=staff_auth, response=list[UndoOut])
def list_undo(request):
    """Cosa può ancora annullare CHI CHIEDE, dal gesto più recente."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    return [_undo_out(entry) for entry in undo_log.stack(ctx.salon, ctx.user)]


@router.post("/undo", auth=staff_auth, response=UndoResultOut)
def undo_last(request, data: UndoIn):
    """Rimette le cose com'erano prima dell'ultimo gesto (o di quello indicato).

    Il 409 qui non è un errore da nascondere: dice che nel frattempo è cambiato
    qualcosa — una collega ha spostato lo stesso appuntamento, il conto è andato
    in cassa — e va mostrato così com'è a chi ha premuto il tasto.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    entries = undo_log.stack(ctx.salon, ctx.user)
    entry = (
        next((e for e in entries if e.id == data.entry_id), None)
        if data.entry_id
        else (entries[0] if entries else None)
    )
    if entry is None:
        raise HttpError(404, "Non c'è niente da annullare")
    return undo_log.perform(entry, actor=ctx.user)
