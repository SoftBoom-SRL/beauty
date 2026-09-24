"""Django settings — youty backend (dashboard salone + web app cliente)."""

import os
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

# Tema e navigazione dell'admin: stanno in config/unfold.py, qui serve solo il
# nome del setting.
from .unfold import UNFOLD  # noqa: F401

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _env_flag(name: str, default: str) -> bool:
    """Interruttore da variabile d'ambiente: acceso solo con "1" (`default` è "1" o "0")."""
    return os.getenv(name, default) == "1"


def _env_list(name: str, default: str = "") -> list[str]:
    """Elenco separato da virgole da variabile d'ambiente, senza spazi e senza voci vuote."""
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


# Chiave di sviluppo: è nel repository, quindi chiunque lo legga può firmare un
# JWT staff valido e un link media firmato. Il controllo più in basso impedisce
# che sopravviva a un avvio con DEBUG spento.
DEV_SECRET_KEY = "dev-insecure-change-me"
# Valori da rifiutare in produzione: oltre al default del codice c'è il
# segnaposto di .env.example, che è quello che si copia davvero per sbaglio.
PLACEHOLDER_SECRET_KEYS = (DEV_SECRET_KEY, "change-me-in-production", "changeme")

SECRET_KEY = os.getenv("SECRET_KEY", DEV_SECRET_KEY)
DEBUG = _env_flag("DEBUG", "1")
ALLOWED_HOSTS = _env_list("ALLOWED_HOSTS", "*")
# L'healthcheck del container chiama http://127.0.0.1:8000/healthz
for _local in ("localhost", "127.0.0.1"):
    if _local not in ALLOWED_HOSTS and "*" not in ALLOWED_HOSTS:
        ALLOWED_HOSTS.append(_local)

INSTALLED_APPS = [
    # unfold: deve precedere django.contrib.admin per sovrascrivere i template
    "unfold",
    "unfold.contrib.filters",
    "unfold.contrib.forms",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    # domain apps
    "apps.core",
    "apps.accounts",
    "apps.clients",
    "apps.staff",
    "apps.catalog",
    "apps.agenda",
    "apps.sales",
    "apps.inventory",
    "apps.marketing",
    "apps.automations",
    "apps.insights",
    "apps.integrations",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # whitenoise serve /static/ (admin Unfold) senza bisogno di un web server davanti
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}",
        conn_max_age=600,
    )
}

# ---------------------------------------------------------------------------
# Fail-closed dei default (non si applica in sviluppo)
# ---------------------------------------------------------------------------
# I default qui sopra servono a far partire `runserver` su un clone appena fatto,
# senza nessuna variabile d'ambiente. Sono però tutti default PERMISSIVI: chiave
# nota, host aperti, database usa e getta. Se una env si perde su Coolify
# l'applicazione ripartiva con quei valori e l'healthcheck rispondeva «ok»: da
# fuori il deploy sembrava riuscito mentre chiunque conoscesse il repository
# poteva firmare un token da titolare (JWT_SECRET ripiega su SECRET_KEY) e i dati
# finivano su uno sqlite dentro il container, cancellato al deploy successivo.
# Meglio non partire affatto: il container resta unhealthy e il rollback di
# Coolify tiene in piedi la versione precedente.
if not DEBUG:
    _misconfigured = []
    if SECRET_KEY in PLACEHOLDER_SECRET_KEYS or len(SECRET_KEY) < 32:
        _misconfigured.append(
            "SECRET_KEY è un segnaposto o è troppo corta: firma i JWT staff e i link "
            "ai media, quindi chi la indovina entra come titolare di qualunque "
            "salone. Generane una con `openssl rand -hex 32`"
        )
    if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
        _misconfigured.append(
            "ALLOWED_HOSTS è aperto a qualunque host: elenca i domini veri "
            "separati da virgola (es. api.esempio.it)"
        )
    if not os.getenv("DATABASE_URL"):
        _misconfigured.append(
            "DATABASE_URL non è impostata: senza, i dati finiscono su uno sqlite "
            "effimero dentro il container e spariscono al prossimo deploy"
        )
    if _misconfigured:
        raise ImproperlyConfigured(
            "Configurazione di produzione incompleta (DEBUG spento):\n- "
            + "\n- ".join(_misconfigured)
        )

# Cache su database, non in memoria: con più worker gunicorn una LocMemCache
# darebbe a ciascuno il suo contatore, e i rate limit che ci si appoggiano non
# limiterebbero niente (verificato in produzione: 9 invii passati su un limite
# di 5). La tabella la crea l'entrypoint con `createcachetable`.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "django_cache",
    }
}

# Logging esplicito: la configurazione di default di Django non fa arrivare a
# stdout gli INFO dei logger applicativi, e senza handler il fallback di Python
# mostra solo WARNING e oltre. Risultato: le nostre righe diagnostiche erano
# invisibili proprio quando servivano (una submission scartata dall'honeypot non
# lasciava traccia).
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"simple": {"format": "%(levelname)s %(name)s: %(message)s"}},
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "simple"},
    },
    "root": {"handlers": ["console"], "level": "WARNING"},
    "loggers": {
        "youty": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "django.request": {"handlers": ["console"], "level": "WARNING", "propagate": False},
    },
}

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "it"
TIME_ZONE = "Europe/Rome"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# In produzione /static/ passa da whitenoise (compressione + hash nei nomi file).
# Niente manifest storage: un riferimento mancante nei CSS di terze parti
# farebbe fallire l'intera pagina invece di degradare.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# I media sono upload degli utenti (logo salone, foto schede, immagini comunicazioni):
# whitenoise indicizza i file all'avvio e non li vedrebbe, quindi li serve Django.
# Metti a 0 se un giorno finiranno su S3 o dietro un nginx dedicato.
SERVE_MEDIA = _env_flag("SERVE_MEDIA", "1")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Dietro il reverse proxy di Coolify (Traefik): senza questo Django crede di
# essere in HTTP e il controllo CSRF dell'admin fallisce.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True

# Indirizzi da cui X-Forwarded-For è credibile, OLTRE alle reti private e a
# localhost (vedi common.ratelimit.client_ip). Serve solo se il reverse proxy
# sta su un'altra macchina e raggiunge il backend da un IP pubblico: senza
# elencarlo qui, tutte le richieste che passano da lì finirebbero nello stesso
# secchiello dei rate limit e un salone intero si bloccherebbe a vicenda.
TRUSTED_PROXY_IPS = tuple(_env_list("TRUSTED_PROXY_IPS"))

# Cookie di sessione e CSRF solo su HTTPS fuori dallo sviluppo: sono i cookie
# dell'admin Django, e in chiaro su una rete condivisa una sessione da titolare
# si intercetta. In sviluppo (DEBUG=1) restano normali, altrimenti il login in
# locale su http non funzionerebbe.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# Redirect a HTTPS e HSTS: li decide chi installa, perché dipendono dal proxy
# davanti all'applicazione. Con Traefik/Coolify che termina TLS bastano
# SECURE_SSL_REDIRECT=1 e SECURE_HSTS_SECONDS=31536000 (vedi DEPLOY.md). HSTS
# NON è attivo per default di proposito: una volta che i browser l'hanno
# ricevuto, tornare su http non è più possibile per la durata dichiarata.
SECURE_SSL_REDIRECT = _env_flag("SECURE_SSL_REDIRECT", "0")
SECURE_HSTS_SECONDS = int(os.getenv("SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = _env_flag("SECURE_HSTS_INCLUDE_SUBDOMAINS", "0")
SECURE_HSTS_PRELOAD = _env_flag("SECURE_HSTS_PRELOAD", "0")
# Il controllo di liveness lo interroga il proxy in HTTP dentro la rete interna:
# redirigerlo lo farebbe fallire e l'applicazione risulterebbe giù.
SECURE_REDIRECT_EXEMPT = [r"^healthz/?$"]

# Origini fidate per il POST di login all'admin (schema incluso: https://api.esempio.it)
CSRF_TRUSTED_ORIGINS = _env_list("CSRF_TRUSTED_ORIGINS")

# CORS — in sviluppo tutto aperto, in produzione whitelist dei frontend
if DEBUG:
    CORS_ALLOW_ALL_ORIGINS = True
else:
    CORS_ALLOWED_ORIGINS = _env_list("CORS_ALLOWED_ORIGINS")
    # L'app cliente serve tutti i saloni da un solo origin (lo slug sta nel path,
    # es. https://beautyclients.esempio.it/the-parlour): basta elencarla sopra
    # insieme alla dashboard, niente pattern.
    #
    # Via di fuga se un giorno servisse un origin variabile. Separatore = spazio,
    # perché la virgola compare nei quantificatori regex ({1,3}). Occhio che i
    # pannelli web raddoppiano i backslash: `\\.` in regex significa "backslash
    # letterale" e il match fallisce in silenzio.
    #
    # Ancoraggio obbligatorio: django-cors-headers usa `re.match`, che verifica
    # solo l'inizio della stringa. Senza `$` finale il pattern per
    # `https://beauty\.esempio\.it` autorizzava anche
    # `https://beauty.esempio.it.attaccante.it`, cioè un origin di chiunque.
    CORS_ALLOWED_ORIGIN_REGEXES = [
        p if p.endswith("$") else f"{p}$"
        for p in os.getenv("CORS_ALLOWED_ORIGIN_REGEXES", "").split()
    ]

# JWT (staff dashboard + clienti web app)
JWT_SECRET = os.getenv("JWT_SECRET", SECRET_KEY)
JWT_ACCESS_TTL_MIN = int(os.getenv("JWT_ACCESS_TTL_MIN", "60"))
JWT_REFRESH_TTL_DAYS = int(os.getenv("JWT_REFRESH_TTL_DAYS", "30"))
# Token della web app cliente: un solo token, senza rinnovo. Prima ereditava la
# durata del refresh staff, che è un'altra cosa e cambiandola cambiava anche
# questa senza che nessuno se ne accorgesse. Chi vuole sessioni cliente più
# corte agisce qui; disattivare la scheda cliente invalida comunque il token
# all'istante (common.auth.ClientAuth filtra su is_active).
JWT_CLIENT_TTL_DAYS = int(os.getenv("JWT_CLIENT_TTL_DAYS", "30"))

# Stripe — opzionale: senza chiave gli endpoint pagamento rispondono 503
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
# Con Stripe Connect gli eventi arrivano da DUE endpoint, ognuno col suo segreto
# di firma: quello dell'account della piattaforma (caparre dei saloni non
# collegati) e quello Connect (caparre dei saloni che hanno collegato il proprio
# Stripe). Con il solo STRIPE_WEBHOOK_SECRET una delle due famiglie veniva
# sempre rifiutata con «Firma webhook non valida»: la cliente pagava e la
# caparra restava «richiesta» fino al rilascio dello slot. Si accettano tutti i
# segreti indicati qui (STRIPE_WEBHOOK_SECRETS separati da virgola, per esempio
# durante la rotazione di un segreto).
STRIPE_CONNECT_WEBHOOK_SECRET = os.getenv("STRIPE_CONNECT_WEBHOOK_SECRET", "")
STRIPE_WEBHOOK_SECRETS = _env_list("STRIPE_WEBHOOK_SECRETS")
# Stripe Connect (Standard): client_id della piattaforma (ca_...) per far
# collegare al titolare il proprio account Stripe dalle Impostazioni.
STRIPE_CONNECT_CLIENT_ID = os.getenv("STRIPE_CONNECT_CLIENT_ID", "")

# Yourang (piattaforma esterna: WhatsApp + esecuzione automazioni).
# Gli eventi vengono accodati in core.OutboxEvent finché le API non sono disponibili.
YOURANG_API_URL = os.getenv("YOURANG_API_URL", "")
YOURANG_API_KEY = os.getenv("YOURANG_API_KEY", "")

# Yourang — connessione OAuth2/OIDC + sync (apps.integrations).
# Stesse convenzioni dei portali food/real_estate. Il client OAuth (id/secret) e
# la whitelist del redirect_uri sono provisionati lato Yourang.
YOURANG_ISSUER_URL = os.getenv("YOURANG_ISSUER_URL", "")  # es. https://api.yourang.ai
YOURANG_CLIENT_ID = os.getenv("YOURANG_CLIENT_ID", "")
YOURANG_CLIENT_SECRET = os.getenv("YOURANG_CLIENT_SECRET", "")
# URL pubblico del webhook receiver (POST /api/integrations/yourang/webhook).
YOURANG_WEBHOOK_RECEIVER_URL = os.getenv("YOURANG_WEBHOOK_RECEIVER_URL", "")
# Cifratura token a riposo (AES-256-GCM, come food/real_estate): openssl rand -hex 32
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "")
# Origine della dashboard (per redirect_uri del popup OAuth).
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
# Origine dell'app cliente (per le pagine di ritorno del pagamento caparra).
# Vuota di serie: se manca si ripiega su FRONTEND_ORIGIN, come dice DEPLOY.md.
# Col vecchio default «http://localhost:5174» il ripiego non scattava mai e in
# produzione, senza la variabile, la cliente che aveva pagato la caparra
# tornava su localhost. In sviluppo si imposta nel .env.
CLIENT_APP_ORIGIN = os.getenv("CLIENT_APP_ORIGIN", "")

# Policy prenotazioni lato cliente (ore minime prima dell'appuntamento)
CLIENT_MOVE_CANCEL_MIN_HOURS = int(os.getenv("CLIENT_MOVE_CANCEL_MIN_HOURS", "24"))
AGENDA_SLOT_STEP_MIN = 15
# Stream live (SSE) accettati contemporaneamente da UN processo gunicorn. Ogni
# stream tiene un thread e una connessione al database finché resta aperto:
# vale circa la metà di `--threads`, così resta sempre spazio per le richieste
# normali. Oltre il tetto la dashboard ripiega da sola sul polling.
#
# Il default era 40 con `--threads 24` (backend/Dockerfile): il tetto non
# scattava mai perché i thread finivano prima, e 24 postazioni sullo stesso
# worker lo paralizzavano per venti minuti — agenda, POS e /media/ compresi —
# senza che nessuno ricevesse il 503 che fa ripiegare sul polling. Se cambi
# `--threads` nel Dockerfile, cambia anche questo: deve restarne circa la metà.
SSE_MAX_CONNECTIONS = int(os.getenv("SSE_MAX_CONNECTIONS", "12"))
