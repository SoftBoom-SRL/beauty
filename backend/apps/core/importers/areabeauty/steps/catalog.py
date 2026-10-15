"""Passo «catalog»: categorie dei servizi, servizi, pacchetti.

Il salone ha già il suo listino in beauty. Un servizio di AreaBeauty con lo
stesso nome (a meno di maiuscole, accenti, punteggiatura e del prefisso «ADD»
degli aggiuntivi: «ADD FOOT SCRUB» è «FOOT SCRUB») si collega a quello e non lo
tocca. Gli altri — vecchi, fuori listino, citati solo dallo storico — si creano
disattivati: lo storico li vuole (voci d'agenda e righe di vendita li
proteggono), il listino no. Anche le loro categorie si creano solo se servono.

Quando i nomi non coincidono decide il file delle corrispondenze (`--map`);
con `"servizi_nome_areabeauty": true` il servizio del listino collegato a mano
prende il nome che aveva in AreaBeauty.

I servizi del listino beauty nella categoria degli aggiuntivi («ADD ON»)
diventano `is_addon`: in agenda si fanno dentro il tempo di un altro servizio.

I pacchetti di AreaBeauty si portano disattivati: il titolare decide se
venderli ancora.
"""

from decimal import Decimal

from apps.catalog.models import Package, PackageItem, Service, ServiceCategory

from ..source import money
from ..util import clip, color, norm, without_addon_prefix

ADDON_CATEGORY_NAMES = {"add on", "add ons", "addon", "addons", "aggiuntivi"}


def run(ctx):
    _mark_addon_categories(ctx)
    categories = {str(c["Id"]): c for c in ctx.source.service_categories if c.get("TipoEntita") in (None, "Servizi", 2, "2")}
    index = _service_index(ctx)
    created_cats: dict[str, ServiceCategory] = {}

    for s in ctx.source.services:
        ext = str(s["Id"])
        if ctx.ref("servizio", ext):
            ctx.count("servizi già collegati")
            _link_mybooker(ctx, s, ctx.ref("servizio", ext))
            continue
        name = clip(s.get("Descrizione1"), 120) or f"Servizio {ext}"
        chosen = (ctx.mapping.get("servizi") or {}).get(ext)
        if chosen and _match(index, chosen) is None:
            ctx.warn(f"corrispondenza: servizio «{chosen}» non trovato in beauty, servizio {ext} creato a parte")
        existing = _match(index, chosen) if chosen else None
        if existing is not None and ctx.mapping.get("servizi_nome_areabeauty"):
            _take_areabeauty_name(ctx, existing, name)
        existing = existing or _match(index, name)
        if existing is not None:
            ctx.link("servizio", ext, existing)
            _link_mybooker(ctx, s, existing.pk)
            ctx.count("servizi collegati al listino")
            continue
        category = _category_for(ctx, s, categories, created_cats)
        minutes = int(s.get("Minuti") or 0)
        client_minutes = int(s.get("MinutiCliente") or minutes)
        service = Service.objects.create(
            salon=ctx.salon,
            category=category,
            name_it=name,
            duration_min=max(0, minutes),
            soak_min=max(0, client_minutes - minutes),
            price=money(s.get("Prezzo")),
            color=color(s.get("Colore"), ""),
            is_addon=norm(name).startswith(("add ", "addon")) or norm(category.name_it) in ADDON_CATEGORY_NAMES,
            active=False,
            order=1000 + int(s.get("PosizionePreferiti") or 0),
        )
        ctx.link("servizio", ext, service)
        _link_mybooker(ctx, s, service.pk)
        ctx.count("servizi creati disattivati")

    _packages(ctx)


def _mark_addon_categories(ctx):
    cats = [c for c in ServiceCategory.objects.filter(salon=ctx.salon) if norm(c.name_it) in ADDON_CATEGORY_NAMES or norm(c.name_en) in ADDON_CATEGORY_NAMES]
    n = Service.objects.filter(salon=ctx.salon, category__in=cats, is_addon=False).update(is_addon=True)
    if n:
        ctx.count("servizi del listino segnati come aggiuntivi", n)


def _take_areabeauty_name(ctx, service, name):
    """Il servizio del listino collegato a mano prende il nome che aveva in AreaBeauty.

    Lo chiede il titolare con `"servizi_nome_areabeauty": true` nel file delle
    corrispondenze. Il nome inglese segue solo se era uguale a quello italiano.
    """
    if service.name_it == name:
        return
    fields = {"name_it": name}
    if service.name_en and service.name_en == service.name_it:
        fields["name_en"] = name
    Service.objects.filter(pk=service.pk).update(**fields)
    for field, value in fields.items():
        setattr(service, field, value)
    ctx.count("servizi del listino col nome di AreaBeauty")


def _service_index(ctx) -> dict[str, Service]:
    """{nome normalizzato: servizio} del listino beauty; a parità di nome vince l'attivo."""
    index: dict[str, Service] = {}
    for s in Service.objects.filter(salon=ctx.salon).order_by("-active", "id"):
        for name in (s.name_it, s.name_en):
            key = norm(name)
            if key:
                index.setdefault(key, s)
                index.setdefault(without_addon_prefix(key), s)
    return index


def _match(index, name):
    key = norm(name)
    return index.get(key) or index.get(without_addon_prefix(key))


def _link_mybooker(ctx, s, service_pk):
    guid = s.get("IdServizioMyBooker")
    if guid and not ctx.ref("servizio_mybooker", guid):
        ctx.link("servizio_mybooker", guid, Service(pk=service_pk))


def _category_for(ctx, s, categories, created) -> ServiceCategory:
    ab_id = str(s.get("IdCategoria") or ((s.get("Categorie") or [{}])[0].get("Id")) or "")
    pk = ctx.ref("categoria_servizio", ab_id) if ab_id else None
    if pk:
        return ServiceCategory.objects.get(pk=pk)
    ab = categories.get(ab_id)
    name = clip((ab or {}).get("Descrizione"), 120) or "AreaBeauty"
    key = ab_id or "_senza"
    if key in created:
        return created[key]
    by_name = {norm(c.name_it): c for c in ServiceCategory.objects.filter(salon=ctx.salon)}
    chosen = (ctx.mapping.get("categorie") or {}).get(ab_id)
    if chosen and norm(chosen) not in by_name:
        ctx.warn(f"corrispondenza: categoria «{chosen}» non trovata in beauty")
    category = by_name.get(norm(chosen)) if chosen else None
    category = category or by_name.get(norm(name))
    if category is None:
        category = ServiceCategory.objects.create(salon=ctx.salon, name_it=name, order=1000)
        ctx.count("categorie create")
    if ab_id:
        ctx.link("categoria_servizio", ab_id, category)
    created[key] = category
    return category


def _packages(ctx):
    for p in ctx.source.packages:
        ext = str(p["Id"])
        if ctx.ref("pacchetto", ext):
            ctx.count("pacchetti già presenti")
            continue
        items = []
        for c in p.get("Componenti") or []:
            service_pk = ctx.ref("servizio", c.get("IdArticoloComponente") or c.get("IdArticolo"))
            if not service_pk:
                ctx.warn(f"pacchetto {ext}: servizio {c.get('IdArticoloComponente')} sconosciuto, voce saltata")
                continue
            items.append((service_pk, int(c.get("Qta") or 1)))
        price = money(p.get("TotaleScontato")) or money(p.get("Prezzo")) or Decimal("0")
        package = Package.objects.create(
            salon=ctx.salon,
            name=clip(p.get("Nome") or p.get("Descrizione1"), 120) or f"Pacchetto {ext}",
            price=price,
            validity_days=p.get("GiorniValidita") or None,
            active=False,
        )
        PackageItem.objects.bulk_create([PackageItem(package=package, service_id=pk, qty=q) for pk, q in items])
        ctx.link("pacchetto", ext, package)
        ctx.count("pacchetti creati disattivati")
