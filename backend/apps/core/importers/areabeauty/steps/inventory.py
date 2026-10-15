"""Passo «inventory»: fornitori, categorie dei prodotti, prodotti.

I prodotti cancellati in AreaBeauty (quasi tutti con ancora qualche pezzo) si
portano disattivati. In beauty il fornitore è obbligatorio: chi non ce l'ha va
sotto «Fornitore non indicato». La giacenza la scrive il passo «stock», dai
movimenti.
"""

from apps.inventory.models import Product, ProductCategory, Supplier

from ..source import ms_dt, money
from ..util import clip, norm

NO_SUPPLIER = "_non_indicato"


def run(ctx):
    _suppliers(ctx)
    categories = _categories(ctx)
    stock = {int(g["ArticoloId"]): g for g in ctx.source.stock if g.get("ArticoloId") is not None}
    active_ids = set()
    for p in ctx.source.products:
        pid = int(p["Id"])
        active_ids.add(pid)
        if ctx.ref("prodotto", pid):
            ctx.count("prodotti già presenti")
            continue
        g = stock.get(pid) or {}
        product = Product.objects.create(
            salon=ctx.salon,
            name=clip(p.get("Descrizione1") or p.get("NomeCommerciale") or g.get("ArticoloDescrizione"), 160) or f"Prodotto {pid}",
            sku=clip(p.get("CodiceInterno") or p.get("CodiceProduttore"), 60),
            brand=clip(p.get("Brand"), 120),
            category=categories.get(str(p.get("IdCategoria") or g.get("CategoriaArticoloId") or "")),
            usage=Product.Usage.INTERNAL if p.get("UsoInterno") else Product.Usage.RETAIL,
            package_unit=clip(p.get("UnitaDiMisura"), 20),
            supplier=_supplier(ctx, g.get("FornitorePredefinitoId")),
            purchase_price=money(p.get("PrezzoAcquisto") or g.get("CostoUltimo")),
            sale_price=money(p.get("Prezzo")),
            vat_rate=_vat(p),
            min_threshold=g.get("GiacenzaMinima") or 0,
            reorder_qty=g.get("QuantitaRiordino") or 0,
            active=True,
        )
        _backdate(ctx, product, p)
        ctx.link("prodotto", pid, product)
        ctx.count("prodotti")

    for g in ctx.source.stock_deleted:
        pid = int(g["ArticoloId"])
        if pid in active_ids or ctx.ref("prodotto", pid):
            continue
        product = Product.objects.create(
            salon=ctx.salon,
            name=clip(g.get("ArticoloDescrizione"), 160) or f"Prodotto {pid}",
            sku=clip(g.get("ArticoloCodiceInterno") or g.get("ArticoloCodiceProduttore"), 60),
            brand=clip(g.get("ArticoloBrand"), 120),
            category=categories.get(str(g.get("CategoriaArticoloId") or "")),
            usage=Product.Usage.INTERNAL,
            supplier=_supplier(ctx, g.get("FornitorePredefinitoId")),
            purchase_price=money(g.get("CostoUltimo")),
            min_threshold=g.get("GiacenzaMinima") or 0,
            reorder_qty=g.get("QuantitaRiordino") or 0,
            active=False,
        )
        ctx.link("prodotto", pid, product)
        active_ids.add(pid)
        ctx.count("prodotti cancellati in AreaBeauty, disattivati")


def _suppliers(ctx):
    existing = {norm(s.name): s for s in Supplier.objects.filter(salon=ctx.salon)}
    for f in ctx.source.suppliers:
        ext = f.get("IdFornitore") or f.get("Id")
        if ctx.ref("fornitore", ext):
            continue
        name = clip(f.get("Denominazione"), 120) or f"Fornitore {ext}"
        supplier = existing.get(norm(name))
        if supplier is None:
            address = " ".join(x for x in (f.get("Indirizzo"), f.get("Civico"), f.get("Cap"), f.get("Citta"), f.get("Provincia")) if x)
            supplier = Supplier.objects.create(
                salon=ctx.salon,
                name=name,
                email=clip(f.get("Email"), 254) if "@" in (f.get("Email") or "") else "",
                phone=clip(f.get("Telefono"), 40),
                address=clip(address, 255),
                vat_number=clip(f.get("PartitaIva"), 20),
                notes=str(f.get("NoteExtra") or "").strip(),
            )
            created = ms_dt(f.get("DataCreazione"))
            if created:
                ctx.backdate(supplier, created_at=created)
            ctx.count("fornitori")
        else:
            ctx.count("fornitori già in beauty, collegati")
        ctx.link("fornitore", ext, supplier)


def _supplier(ctx, ab_id):
    pk = ctx.ref("fornitore", ab_id)
    if pk:
        return Supplier(pk=pk)
    pk = ctx.ref("fornitore", NO_SUPPLIER)
    if pk:
        return Supplier(pk=pk)
    supplier = Supplier.objects.create(salon=ctx.salon, name="Fornitore non indicato")
    ctx.link("fornitore", NO_SUPPLIER, supplier)
    ctx.count("fornitore di ripiego creato")
    return supplier


def _categories(ctx) -> dict[str, ProductCategory]:
    existing = {norm(c.name): c for c in ProductCategory.objects.filter(salon=ctx.salon)}
    out = {}
    for c in ctx.source.service_categories:
        if c.get("TipoEntita") not in ("Prodotti", 3, "3"):
            continue
        ext = str(c["Id"])
        pk = ctx.ref("categoria_prodotto", ext)
        if pk:
            out[ext] = ProductCategory(pk=pk)
            continue
        name = clip(c.get("Descrizione"), 120) or f"Categoria {ext}"
        category = existing.get(norm(name)) or ProductCategory.objects.create(salon=ctx.salon, name=name)
        ctx.link("categoria_prodotto", ext, category)
        out[ext] = category
    return out


def _vat(p) -> int:
    iva = p.get("Iva") or {}
    rate = iva.get("Aliquota") if isinstance(iva, dict) else iva
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return 22
    return int(round(rate * 100 if rate < 1 else rate))


def _backdate(ctx, product, p):
    created, modified = ms_dt(p.get("DataCreazione")), ms_dt(p.get("DataModifica"))
    fields = {}
    if created:
        fields["created_at"] = created
    if modified:
        fields["updated_at"] = modified
    ctx.backdate(product, **fields)
