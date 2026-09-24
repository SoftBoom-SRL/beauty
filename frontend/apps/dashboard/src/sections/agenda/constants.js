// constants.js — i numeri dell'agenda che più file devono condividere.
// Erano scritti a mano in ogni vista (il colore della riga dell'ora, il passo
// della rotella, la colonna delle ore…): cambiarne uno voleva dire cercarli
// tutti, e bastava dimenticarne una copia perché giorno e settimana non
// fossero più uguali. Nessun import: lo caricano anche i test con `node --test`.

export const DK_START = 8 * 60;   // grid 08:00
export const DK_END = 20 * 60;    // grid 20:00
export const PXM = 1.35;          // px per minute (zoom 1)

/* ---- Zoom delle viste calendario -------------------------------------------
 * Quanto è alta un'ora sullo schermo. È una preferenza PERSONALE della
 * postazione, non del salone: chi sta al banco su un monitor grande vuole
 * vedere la giornata intera, chi lavora su un portatile vuole leggere i
 * quarti d'ora. Non tocca MAI la fascia di prenotazione (Impostazioni →
 * intervallo slot), che resta una regola del salone: qui si cambia solo la
 * scala del disegno, come fanno i calendari professionali (Fresha ha uno
 * "zoom" personale a cursore, Vagaro la spaziatura delle righe più il pinch,
 * Apple "quante ore vedere per schermata").
 * I passi sono moltiplicatori di PXM; «adatta» calcola un valore libero. */
export const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.25, 1.6, 2];
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;
/** Un colpo di rotella (o di pinch) con ⌘/ctrl: la scala si moltiplica (o si
 *  divide) per tanto. Uguale in giorno e settimana. */
export const WHEEL_ZOOM_FACTOR = 1.12;

export const COLW = 158;          // min operator column width

/** Passo dell'agenda quando le Impostazioni non lo dicono (minuti). */
export const DEFAULT_SLOT_MIN = 15;

/** Colonna delle ore a sinistra: vista giorno (fissa durante lo scorrimento)
 *  e vista settimana, più stretta. */
export const DAY_HOURS_W = 64;
export const WEEK_HOURS_W = 46;

/** La riga rossa dell'ora attuale, in giorno e settimana. */
export const NOW_LINE_COLOR = '#F4708A';

/** Ultimo inizio che il pannello di dettaglio accetta scrivendo o spostando
 *  l'orario a mano: le 23:55, l'ultimo passo di cinque minuti del giorno. */
export const LAST_START_MIN = 23 * 60 + 55;

/** Da qui comincia il pomeriggio: le preferenze «mattina/pomeriggio» della
 *  lista d'attesa e i due gruppi di orari del drawer «Nuova prenotazione». */
export const AFTERNOON_MIN = 13 * 60;

/** Pause dal menu dello slot: le durate proposte e quella di partenza. */
export const BREAK_PRESETS = [15, 30, 45, 60, 90, 120];
export const BREAK_DEFAULT_MIN = 60;

/** Anteprima di un appuntamento al passaggio del mouse: quanto deve restare
 *  libero sotto la scheda (vista giorno e vista settimana). */
export const HOVER_CLEAR_DAY = 260;
export const HOVER_CLEAR_WEEK = 280;

/** Attesa fra la chiusura di un modale e l'apertura del successivo (slot
 *  liberato → lista d'attesa o nuova prenotazione). */
export const MODAL_SWAP_MS = 150;

/** Eventi live dopo cui le viste giorno, settimana e mese si ricaricano.
 *  Ognuna ne ascoltava un pezzo diverso, e ciascuna restava ferma su qualcosa:
 *  - `deposit.` e `sale.`: la caparra pagata online e l'incasso in cassa
 *    (anche `appointment.closed` del conto) — in settimana e nel mese il
 *    pallino «caparra da versare» e la visita «in corso» restavano lì;
 *  - `operator.` e `settings.`: turni, assenze e orari del centro cambiati da
 *    un'altra postazione — la colonna di un'assente restava «in turno», il
 *    trascinamento diceva «Disponibile» e lo spostamento partiva forzato sopra
 *    un'assenza, senza che nessuno lo vedesse; nel mese l'occupazione restava
 *    quella vecchia. */
export const AGENDA_LIVE_RE = /^(appointment|pause|waitlist|slot|visit|sale|deposit|operator|settings)\./;
