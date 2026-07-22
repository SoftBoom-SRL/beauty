from datetime import datetime
from typing import Optional

from ninja import Schema


class AuthorizeOut(Schema):
    authorize_url: str


class ExchangeIn(Schema):
    code: str
    state: str


class StatusOut(Schema):
    connected: bool
    status: str = "disconnected"
    connected_at: Optional[datetime] = None
    last_sync_at: Optional[datetime] = None
    scope: str = ""
    yourang_org_id: str = ""


class OkOut(Schema):
    ok: bool = True
