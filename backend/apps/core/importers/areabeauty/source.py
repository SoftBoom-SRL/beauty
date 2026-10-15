"""Lettura dell'export grezzo di AreaBeauty: i file JSON così come li ha salvati l'export.

Ogni metodo carica i suoi file una volta sola (pigro) e restituisce i record di
AreaBeauty senza trasformarli, tranne lo stretto necessario per non doverli
spacchettare in ogni passo (paginazioni, doppioni della paginazione, blocchi
interni dell'agenda). Le conversioni di date e importi sono funzioni in fondo.

Le date di AreaBeauty arrivano in tre forme:
- `/Date(1680001200000)/`: millisecondi epoch, istante giusto in UTC → `ms_dt`;
- `"28.03.2023 13:00"` (planning) e `"2026-10-15T10:00:00"` (dettagli): ora
  locale del salone, senza fuso → `local_dt`;
- `"15/10/2026"`, `"2026-10-15"`: giorni → `day`.
"""

import datetime as dt
import json
import os
import re
from decimal import Decimal
from functools import cached_property
from zoneinfo import ZoneInfo

ROME = ZoneInfo("Europe/Rome")
CENT = Decimal("0.01")
# Servizi di AreaBeauty che in agenda non sono trattamenti: la caparra versata
# e il buono regalo cartaceo erano «righe» del planning a prezzo zero.
PSEUDO_SERVICE_IDS = {781, 714}
# GUID vuoto: le righe «uso interno» dell'agenda (lista d'attesa) hanno questo cliente.
EMPTY_GUID = "00000000-0000-0000-0000-000000000000"


class RawSource:
    """L'export di un negozio AreaBeauty, letto dalla cartella `root`."""

    def __init__(self, root: str):
        if not os.path.isdir(root):
            raise FileNotFoundError(f"Cartella dell'export non trovata: {root}")
        self.root = root

    # --- file ---------------------------------------------------------------
    def _load(self, *parts):
        path = os.path.join(self.root, *parts)
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def _load_dir(self, *parts):
        folder = os.path.join(self.root, *parts)
        for name in sorted(os.listdir(folder)):
            if name.endswith(".json"):
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    yield json.load(fh)

    def has(self, *parts) -> bool:
        return os.path.exists(os.path.join(self.root, *parts))

    # --- clienti ------------------------------------------------------------
    @cached_property
    def clients_list(self) -> list[dict]:
        """`clienti/elenco`: una riga per cliente (Id, Name, Surname, Phone, Email, Sesso, DataNascita…)."""
        rows = {}
        for blob in self._load_dir("clienti", "elenco"):
            for row in blob["data"]:
                rows[row["Id"]] = row
        return list(rows.values())

    @cached_property
    def client_details(self) -> dict[str, dict]:
        """`clienti/dettaglio`: {Id cliente: {customer, riepilogo, schede}}."""
        out = {}
        for blob in self._load_dir("clienti", "dettaglio"):
            for rec in blob:
                out[rec["id"]] = rec
        return out

    @cached_property
    def client_groups(self) -> list[dict]:
        return _walk(self._load("clienti", "gruppi.json"), lambda d: "Descrizione" in d and "Id" in d)

    @cached_property
    def cancellations(self) -> list[dict]:
        """Appuntamenti annullati (anche no-show), uno per `IdAppuntamento`.

        Il riepilogo della cliente ne mostra al massimo 5; per chi ne ha di più
        la lista completa è in `clienti/annullati_completi.json`.
        """
        out = {}
        for rec in self.client_details.values():
            for a in (rec.get("riepilogo") or {}).get("dati", {}).get("appAnnullati") or []:
                out[a["IdAppuntamento"]] = a
        if self.has("clienti", "annullati_completi.json"):
            for a in _walk(self._load("clienti", "annullati_completi.json"), lambda d: "IdAppuntamento" in d and "Motivazione" in d):
                out[a["IdAppuntamento"]] = a
        return list(out.values())

    # --- agenda -------------------------------------------------------------
    @cached_property
    def _planning(self) -> tuple[list[dict], list[dict]]:
        services, waitlist, seen = [], [], set()
        for blob in self._load_dir("appuntamenti", "planning"):
            for week in blob:
                for row in (week.get("dati") or {}).get("Appuntamenti") or []:
                    if row.get("eventType") == 1:
                        waitlist.append(row)
                        continue
                    guid = row.get("id_appuntamentoGuid")
                    if guid in seen:
                        continue
                    seen.add(guid)
                    services.append(row)
        return services, waitlist

    @property
    def planning_rows(self) -> list[dict]:
        """Le righe-servizio del planning (una per servizio prenotato), senza doppioni."""
        return self._planning[0]

    @property
    def waitlist_rows(self) -> list[dict]:
        """La colonna «Lista Attesa» del planning: testo libero, senza cliente né servizio."""
        return self._planning[1]

    @cached_property
    def planning_presence(self) -> list[dict]:
        """Presenze del planning (Ferie, Assenza, Chiusura, NP) per colonna operatrice."""
        out = []
        for blob in self._load_dir("appuntamenti", "planning"):
            for week in blob:
                out.extend((week.get("dati") or {}).get("Presenze") or [])
        return out

    # --- vendite ------------------------------------------------------------
    @cached_property
    def sales(self) -> dict[int, dict]:
        """`vendite/dettaglio`: {IdTransazione: dati} con Servizi, Prodotti, Coupons, Pagamenti, Importi…"""
        out = {}
        for blob in self._load_dir("vendite", "dettaglio"):
            for rec in blob:
                out[int(rec["IdTransazione"])] = rec["dati"]
        return out

    # --- catalogo -----------------------------------------------------------
    @cached_property
    def services(self) -> list[dict]:
        """Servizi del listino (attivi) più quelli fuori listino citati da appuntamenti o vendite."""
        out = {}
        for page in self._load("catalogo", "servizi.json")["pagine"]:
            for s in page["dati"]["servizi"]:
                out[s["Id"]] = s
        for name in ("servizi_fuori_listino_appuntamenti_dettaglio.json", "servizi_fuori_listino_vendite_dettaglio.json"):
            if self.has("catalogo", name):
                for s in _walk(self._load("catalogo", name), lambda d: "Descrizione1" in d and "Id" in d and "Minuti" in d):
                    out.setdefault(s["Id"], {**s, "_fuori_listino": True})
        return list(out.values())

    @cached_property
    def service_categories(self) -> list[dict]:
        return _walk(self._load("catalogo", "categorie_articoli.json"), lambda d: "Descrizione" in d and "Id" in d)

    @cached_property
    def packages(self) -> list[dict]:
        """Pacchetti di listino e fuori listino, con `Componenti` (servizio e quantità)."""
        out = {}
        for name in ("pacchetti_dettaglio.json", "pacchetti_fuori_listino_dettaglio.json"):
            if self.has("catalogo", name):
                for p in _walk(self._load("catalogo", name), lambda d: "Componenti" in d and "Id" in d):
                    out.setdefault(p["Id"], p)
        return list(out.values())

    # --- staff --------------------------------------------------------------
    @cached_property
    def operators(self) -> list[dict]:
        """Operatori (anche non più in planning): Id GUID, Nome, Cognome, Colore, VisibileInPlanning…"""
        rows = _walk(self._load("configurazione", "operatori.json"), lambda d: "VisibileInPlanning" in d)
        return list({r["Id"]: r for r in rows}.values())

    @cached_property
    def cancel_motives(self) -> dict[int, str]:
        rows = _walk(self._load("configurazione", "motivi_annullamento.json"), lambda d: "Descrizione" in d and "FlagAppuntamenti" in d)
        return {r["Id"]: r["Descrizione"] for r in rows}

    # --- magazzino ----------------------------------------------------------
    @cached_property
    def products(self) -> list[dict]:
        return [p for page in self._load("catalogo", "prodotti.json")["pagine"] for p in page["dati"]["prodotti"]]

    @cached_property
    def stock(self) -> list[dict]:
        """Giacenze dei prodotti attivi."""
        return [g for page in self._load("magazzino", "giacenze.json")["pagine"] for g in page["dati"]["giacenze"]]

    @cached_property
    def stock_deleted(self) -> list[dict]:
        """Giacenze dei prodotti cancellati in AreaBeauty (303, quasi tutti ancora con pezzi)."""
        if not self.has("magazzino", "giacenze_con_cancellati.json"):
            return []
        return [g for page in self._load("magazzino", "giacenze_con_cancellati.json")["pagine"] for g in page["dati"]["giacenze"]]

    @cached_property
    def movements(self) -> list[dict]:
        return [m for page in self._load("magazzino", "movimenti.json")["pagine"] for m in page["dati"]["movimenti"]]

    @cached_property
    def suppliers(self) -> list[dict]:
        return _walk(self._load("magazzino", "fornitori.json"), lambda d: "Denominazione" in d and ("IdFornitore" in d or "Id" in d))

    # --- coupon (gift box) --------------------------------------------------
    @cached_property
    def coupons(self) -> list[dict]:
        """Gift box emesse (184): un servizio, un utilizzo, validità 180 giorni."""
        return [c for page in self._load("coupon", "emessi_stato_null.json")["pagine"] for c in page["dati"]["coupons"]]

    @cached_property
    def coupon_uses(self) -> dict[int, list[dict]]:
        """{IdCoupon: [utilizzi]} con IdTransazione, IdCliente, Data, TotaleIncassatoCoupon."""
        out = {}
        for item in self._load("coupon", "utilizzi.json")["dettagli"]:
            out[int(item["id"])] = (item.get("dati") or {}).get("utilizzi") or []
        return out


# --- conversioni -----------------------------------------------------------
_MS = re.compile(r"^/Date\((-?\d+)")


def ms_dt(value):
    """`/Date(ms)/` → datetime aware (UTC). None se vuoto o non riconosciuto."""
    m = _MS.match(value or "")
    if not m:
        return None
    return dt.datetime(1970, 1, 1, tzinfo=dt.UTC) + dt.timedelta(milliseconds=int(m.group(1)))


def local_dt(value):
    """Ora locale del salone senza fuso → datetime aware Europe/Rome.

    Accetta `dd.mm.yyyy HH:MM` (planning), `yyyy-mm-ddTHH:MM[:SS]` (dettagli) e
    `dd/mm/yyyy HH:MM`. None se vuoto. Gli anni 0001 di AreaBeauty («nessuna
    data») diventano None.
    """
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%d.%m.%Y %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M"):
        try:
            naive = dt.datetime.strptime(text[: len(dt.datetime(2000, 1, 1).strftime(fmt))], fmt)
        except ValueError:
            continue
        if naive.year < 1900:
            return None
        return naive.replace(tzinfo=ROME)
    return None


def day(value):
    """Un giorno (`yyyy-mm-dd…`, `dd/mm/yyyy`, `dd.mm.yyyy`) → date. None se vuoto."""
    if not value:
        return None
    text = str(value).strip()
    for fmt, n in (("%Y-%m-%d", 10), ("%d/%m/%Y", 10), ("%d.%m.%Y", 10)):
        try:
            d = dt.datetime.strptime(text[:n], fmt).date()
        except ValueError:
            continue
        return None if d.year < 1900 else d
    return None


def money(value) -> Decimal:
    """Importo di AreaBeauty (int o float JSON) → Decimal al centesimo."""
    return Decimal(str(value or 0)).quantize(CENT)


def _walk(obj, match) -> list[dict]:
    """Tutti i dizionari dentro `obj` per cui `match(d)` è vero (le risposte hanno involucri diversi)."""
    found = []

    def visit(o):
        if isinstance(o, dict):
            if match(o):
                found.append(o)
                return
            for v in o.values():
                visit(v)
        elif isinstance(o, list):
            for v in o:
                visit(v)

    visit(obj)
    return found
