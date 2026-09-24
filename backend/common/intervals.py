"""Aritmetica sugli intervalli (inizio, fine): turni, fasce di apertura, orari occupati."""


def merge_intervals(intervals):
    """Unisce gli intervalli che si sovrappongono O SI TOCCANO, in ordine.

    [(9, 13), (13, 18), (20, 21)] → [(9, 18), (20, 21)]: due righe contigue
    (9–13 e 13–18) sono lo stesso turno, la stessa apertura, la stessa
    occupazione. Lasciate separate, un servizio che attraversa le 13 non
    entrerebbe per intero in nessuna delle due e l'orario non verrebbe mai
    proposto.

    Era scritta identica quattro volte: `staff.services._merge_windows` (turni),
    `agenda.services._opening_bands` (fasce di apertura), `_merge_spans`
    (orari occupati da annunciare alla lista d'attesa) e dentro
    `_slot_is_recommended` (segmenti della stessa operatrice). Questa è la
    stessa riga per riga, così le copie si possono sostituire senza cambiare
    nulla:

    - si ordina con `sorted` sulle coppie: per inizio, a parità per fine;
    - si fondono anche gli intervalli che si toccano (`<=`, non `<`);
    - l'inizio resta quello del primo, la fine è la maggiore delle due;
    - esce sempre una lista NUOVA di tuple, anche se in ingresso c'erano
      liste; l'input non si modifica.

    Vale per qualsiasi valore confrontabile: minuti da mezzanotte (int) o
    istanti (datetime).
    """
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged
