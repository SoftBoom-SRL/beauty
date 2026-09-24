// useOpenApptCopy — la copia fresca dell'appuntamento aperto nel pannello di
// dettaglio, per l'ombra e per «Sposta qui».
// Le props del modale restano quelle dell'apertura, mentre il pannello salva e
// aggiorna solo il proprio stato: dopo «Passa a Bea» l'ombra restava nella
// colonna di Anna e «Sposta qui» mandava Anna come operatrice di partenza — il
// server non trovava i suoi servizi, e l'appuntamento restava a Bea (se
// occupata, forzato sopra la sua cliente) mentre l'avviso diceva «Spostato a
// Carla». Si rilegge a ogni modifica segnalata dal pannello, legata all'id del
// modale perché riaprendone un altro la copia vecchia non valga più.
import { useCallback, useRef, useState } from 'react';
import * as agendaApi from '../agendaApi.js';
import { useLatest } from './useLatest.js';

/** Ritorna { modalRef (il modale aperto adesso), reloadOpenAppt(id),
 *  openAppt (la copia più fresca che si ha, o null senza pannello) }. */
export function useOpenApptCopy(modal) {
  const modalRef = useLatest(modal);
  const [apptFresh, setApptFresh] = useState(null);   // { modalId, appt }
  const freshSeq = useRef(0);
  const reloadOpenAppt = useCallback((id) => {
    const m = modalRef.current;
    if (!m || m.name !== 'apptdetail' || m.props?.appointment?.id !== id) return;
    const my = ++freshSeq.current;
    agendaApi.getAppointment(id)
      .then((fresh) => {
        if (my === freshSeq.current && modalRef.current?.id === m.id) setApptFresh({ modalId: m.id, appt: fresh });
      })
      .catch(() => { /* resta la copia che c'è */ });
  }, [modalRef]);
  // La copia più fresca che si ha: quella riletta dopo le modifiche del
  // pannello, altrimenti quella dell'apertura.
  const openAppt = modal?.name === 'apptdetail'
    ? ((apptFresh && apptFresh.modalId === modal.id && apptFresh.appt) || modal.props?.appointment || null)
    : null;
  return { modalRef, reloadOpenAppt, openAppt };
}
