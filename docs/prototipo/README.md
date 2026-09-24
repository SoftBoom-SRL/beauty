# Prototipo originale (luglio 2026)

Il prototipo da cui è nato il frontend: React caricato da CDN e JSX compilato nel
browser da Babel standalone, senza build. È **congelato** alla prima commit del
progetto (`e01dcd2`) e non si mantiene: il codice vivo è in `frontend/`.

Resta qui come riferimento del disegno di partenza: alcuni commenti del codice
citano ancora questi file (per esempio `desktop-agenda.jsx`, `screen-cliente.jsx`,
`data.jsx`).

Per aprirlo in locale (serve la rete: React e Babel arrivano da unpkg):

```sh
cd docs/prototipo
python3 -m http.server 8080
# poi http://localhost:8080/yourang-desktop.html (gestionale)
#  e   http://localhost:8080/yourang.html         (app cliente)
```

Non fa parte di nessun build né di nessun deploy: i Dockerfile usano come
contesto `backend/` e `frontend/`.
