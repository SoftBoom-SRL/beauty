# Backend Django (API + admin) — immagine di produzione.
# Build context: la cartella `backend/`.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# curl serve solo all'healthcheck del container
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

# Utente senza privilegi: questo container è l'unico che scrive su disco file
# arrivati da fuori (logo, foto delle schede tecniche, allegati), quindi non
# deve girare come root. `media/` e `staticfiles/` vanno creati e assegnati
# PRIMA di USER: collectstatic gira a ogni avvio e gli upload atterrano in
# media/, che a runtime è un volume montato sopra questa cartella.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --create-home app \
 && chmod +x entrypoint.sh \
 && mkdir -p media staticfiles \
 && chown -R app:app /app

USER app

EXPOSE 8000

# start-period generoso: il primo avvio su database vuoto fa migrate +
# createcachetable + collectstatic prima ancora di aprire la porta, e con 40s
# l'healthcheck falliva tre volte prima che gunicorn esistesse — il container
# entrava in ciclo di riavvii proprio al primo deploy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

ENTRYPOINT ["./entrypoint.sh"]
# gthread: le connessioni SSE della dashboard (aggiornamenti in tempo reale)
# restano aperte a lungo; con worker sync ognuna bloccherebbe un processo intero.
CMD ["gunicorn", "config.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "3", \
     "--worker-class", "gthread", \
     "--threads", "24", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
