// DetailFooter — il piede del pannello di dettaglio, sempre in vista: le
// modifiche da salvare, le azioni che fanno avanzare la visita (check-in,
// inizio, incasso, riprogrammazione) e, in fondo e più piccole, quelle che
// tolgono qualcosa (no-show, annullamento). Senza hook: i comandi arrivano
// dal pannello.
import React from 'react';
import { Icon } from '@youty/shared';
import { canMarkNoShow } from '../rules.js';

export default function DetailFooter({
  appt, t, itemsEditable, dirty, itemsDirty, noteDirty, savingItems, editItems, terminal, canWrite, busy,
  saveChanges, checkIn, startAppt, checkout, startReschedule, onDiscard, onNoShow, onCancel,
}) {
  return (
    <React.Fragment>
      {/* Le azioni comuni stanno qui sotto, sempre in vista: chi apre un
          appuntamento nove volte su dieci deve far entrare la cliente,
          incassare o spostarlo, e prima bisognava scorrere per trovarle.
          Una sola azione piena (clay): quella che fa avanzare il lavoro. */}
      {/* Modifiche in sospeso: il salvataggio sta QUI, dove si vede sempre.
          In fondo alla lista dei servizi finiva sotto il bordo del pannello
          proprio dopo aver aggiunto un trattamento. */}
      {itemsEditable && dirty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 10px', borderRadius: 12, background: 'var(--clay-tint)' }}>
          <Icon name="alert" size={15} color="var(--clay-ink)" />
          <span className="t-sm" style={{ flex: 1, minWidth: 0, color: 'var(--clay-ink)', fontWeight: 600 }}>
            {itemsDirty && noteDirty ? t('Servizi e nota da salvare', 'Services and note to save')
              : itemsDirty ? t('Servizi da salvare', 'Services to save') : t('Nota da salvare', 'Note to save')}
          </span>
          <button className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} disabled={savingItems}
            onClick={onDiscard}>{t('Annulla', 'Discard')}</button>
          <button className="dk-btn dk-btn--clay" style={{ height: 32, fontSize: 12.5 }} disabled={savingItems || !editItems.length} onClick={() => saveChanges()}>
            <Icon name="check" size={14} color="#fff" />{savingItems ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        </div>
      )}
      {!terminal && canWrite && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {appt.status === 'confirmed' && (
            <button className="dk-btn dk-btn--clay" disabled={busy} style={{ height: 46, width: '100%' }} onClick={checkIn}>
              <Icon name="check" size={18} color="#fff" />{t('Check-in', 'Check in')}
            </button>
          )}
          {appt.status === 'checked_in' && (
            <button className="dk-btn dk-btn--clay" disabled={busy} style={{ height: 46, width: '100%' }} onClick={startAppt}>
              <Icon name="play" size={17} color="#fff" />{t('Inizia trattamento', 'Start treatment')}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={'dk-btn ' + (appt.status === 'in_progress' ? 'dk-btn--clay' : 'dk-btn--soft')} style={{ flex: 1, height: 42 }} onClick={checkout}>
              <Icon name="wallet" size={17} color={appt.status === 'in_progress' ? '#fff' : undefined} />{t('Incassa', 'Check out')}
            </button>
            <button className="dk-btn dk-btn--soft" style={{ flex: 1, height: 42 }} onClick={startReschedule}
              title={t('Cerca un orario libero o sposta a un altro giorno (per l’ora e la persona di oggi bastano i comandi qui sopra)', 'Find a free time or move to another day (for today’s time and stylist use the controls above)')}>
              <Icon name="calendar" size={16} />{t('Riprogramma', 'Reschedule')}
            </button>
          </div>
        </div>
      )}
      {/* Tolgono qualcosa: colore proprio (rosso di contorno), in fondo e
          più piccole. Prima erano due scritte grigie come il resto. */}
      {!terminal && canWrite && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {/* Solo per chi era attesa e non è arrivata: il server rifiuta il
              no-show di chi è già in salone o di una visita non ancora
              cominciata (caparra trattenuta e storico sporcato). */}
          {canMarkNoShow(appt) && (
            <button className="dk-btn dk-btn--danger" style={{ flex: 1, height: 34, fontSize: 12.5 }}
              onClick={onNoShow}>
              <Icon name="alert" size={14} color="var(--danger)" />No-show
            </button>
          )}
          <button className="dk-btn dk-btn--danger" style={{ flex: 1, height: 34, fontSize: 12.5 }}
            onClick={onCancel}>
            <Icon name="x" size={14} color="var(--danger)" />{t('Cancella', 'Cancel booking')}
          </button>
        </div>
      )}
    </React.Fragment>
  );
}
