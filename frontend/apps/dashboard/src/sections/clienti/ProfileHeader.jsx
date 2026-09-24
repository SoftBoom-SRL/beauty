// ProfileHeader.jsx — la testata della scheda cliente (ClientProfile): foto,
// nome, genere, compleanno vicino, lista d'attesa e i pulsanti di contatto.
// Senza numero o email i pulsanti restano e dicono con un avviso perché non
// possono aprire niente.
import { Avatar, Icon } from '@youty/shared';
import { initialsOf, waHref, daysToBirthday } from './helpers.js';
import { genderLabel, genderGlyph } from '../../ui/GenderPicker.jsx';

const btnA = { textDecoration: 'none' }; // anchor-as-button

export default function ProfileHeader({ c, onWaitlist, canWrite, archived, openEdit, onArchive, t, fireToast }) {
  const wa = waHref(c.phone);
  const sinceYear = c.since ? String(c.since).slice(0, 4) : null;
  const bdays = daysToBirthday(c.birthday);
  const subtitle = [
    genderLabel(c.gender, t),
    c.age != null ? t(`${c.age} anni`, `${c.age} years old`) : null,
    sinceYear ? t(`cliente dal ${sinceYear}`, `client since ${sinceYear}`) : null,
    c.origin || null,
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 22, flexWrap: 'wrap' }}>
      <Avatar initials={initialsOf(c.full_name)} size={76} />
      <div style={{ flex: '1 1 210px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500 }}>{c.full_name}</span>
          {c.gender && <span title={genderLabel(c.gender, t)} aria-label={genderLabel(c.gender, t)} style={{ fontSize: 18, color: 'var(--muted)', lineHeight: 1 }}>{genderGlyph(c.gender)}</span>}
          {bdays != null && bdays <= 14 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--warn-tint)', color: 'var(--warn)', whiteSpace: 'nowrap' }}>
              <Icon name="cake" size={12} color="var(--warn)" />{bdays === 0 ? t('Compleanno oggi!', 'Birthday today!') : bdays === 1 ? t('Compleanno domani', 'Birthday tomorrow') : t(`Compleanno tra ${bdays} giorni`, `Birthday in ${bdays} days`)}
            </span>
          )}
          {onWaitlist && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--clay-tint)', color: 'var(--clay-ink)', border: '1px solid color-mix(in srgb, var(--clay) 25%, transparent)', whiteSpace: 'nowrap' }}>
              <Icon name="clock" size={11} color="var(--clay-ink)" />{t("In lista d'attesa", 'On waiting list')}
            </span>
          )}
        </div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, textTransform: 'none' }}>
          {subtitle || t('Cliente', 'Client')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {c.wa && wa
          ? <a className="dk-btn dk-btn--ghost" style={btnA} href={wa} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</a>
          : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('WhatsApp non disponibile', 'WhatsApp unavailable'), icon: 'whatsapp' })}><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</button>}
        {c.phone
          ? <a className="dk-btn dk-btn--ghost" style={btnA} href={`tel:${c.phone}`}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</a>
          : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Nessun numero di telefono', 'No phone number'), icon: 'phone' })}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</button>}
        {c.email
          ? <a className="dk-btn dk-btn--ghost" style={btnA} href={`mailto:${c.email}`}><Icon name="mail" size={17} />Email</a>
          : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Nessuna email in anagrafica', 'No email on file'), icon: 'mail' })}><Icon name="mail" size={17} />Email</button>}
        <button className="dk-btn dk-btn--clay" title={t('La conversazione si gestisce su Yourang', 'The conversation is managed on Yourang')} onClick={() => fireToast({ msg: t('Apertura di Yourang…', 'Opening Yourang…'), icon: 'ext' })}><Icon name="ext" size={16} color="#fff" />Yourang</button>
        {canWrite && (
          <button className="dk-btn dk-btn--ghost" onClick={openEdit} title={t('Modifica dati anagrafici', 'Edit personal details')}><Icon name="edit" size={16} />{t('Modifica', 'Edit')}</button>
        )}
        {canWrite && !archived && (
          <button className="dk-iconbtn" title={t('Archivia cliente', 'Archive client')} onClick={onArchive} style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--hair))' }}>
            <Icon name="x" size={16} color="var(--danger)" />
          </button>
        )}
      </div>
    </div>
  );
}
