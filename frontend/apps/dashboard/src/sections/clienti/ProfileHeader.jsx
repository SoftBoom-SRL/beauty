// ProfileHeader.jsx — la testata della scheda cliente (ClientProfile): foto,
// nome, genere, compleanno vicino, lista d'attesa, quanto resta da saldare e i
// pulsanti di contatto. Senza numero o email i pulsanti restano e dicono con
// un avviso perché non possono aprire niente; la cliente senza un numero suo
// che si contatta tramite un'altra («tramite Laura») si chiama e si scrive al
// numero di lei.
import { Avatar, Icon, fmtEur } from '@youty/shared';
import { initialsOf, waHref, daysToBirthday, phoneLine, reachPhone, amountDue } from './helpers.js';
import { genderLabel, genderGlyph } from '../../ui/GenderPicker.jsx';

const btnA = { textDecoration: 'none' }; // anchor-as-button
const pill = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' };

export default function ProfileHeader({ c, onWaitlist, canWrite, archived, openEdit, onArchive, onOpenClient, t, lang, fireToast }) {
  const number = reachPhone(c);
  const viaContact = !c.phone && !!number;
  const wa = waHref(number);
  const sinceYear = c.since ? String(c.since).slice(0, 4) : null;
  const bdays = daysToBirthday(c.birthday);
  const due = amountDue(c);
  const line = phoneLine(c, t);
  const subtitle = [
    genderLabel(c.gender, t),
    c.age != null ? t(`${c.age} anni`, `${c.age} years old`) : null,
    sinceYear ? t(`cliente dal ${sinceYear}`, `client since ${sinceYear}`) : null,
    c.origin || null,
  ].filter(Boolean).join(' · ');
  const viaTitle = viaContact ? t(`Numero di ${c.contact.full_name}`, `${c.contact.full_name}’s number`) : '';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 22, flexWrap: 'wrap' }}>
      <Avatar initials={initialsOf(c.full_name)} size={76} />
      <div style={{ flex: '1 1 210px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500 }}>{c.full_name}</span>
          {c.gender && <span title={genderLabel(c.gender, t)} aria-label={genderLabel(c.gender, t)} style={{ fontSize: 18, color: 'var(--muted)', lineHeight: 1 }}>{genderGlyph(c.gender)}</span>}
          {due != null && (
            <span title={t('Conti non saldati: il saldo si fa in cassa', 'Unpaid bills: settle them at the till')} style={{ ...pill, background: 'var(--danger-tint)', color: 'var(--danger)' }}>
              <Icon name="wallet" size={12} color="var(--danger)" />{t(`Da saldare ${fmtEur(due, lang)}`, `${fmtEur(due, lang)} to pay`)}
            </span>
          )}
          {bdays != null && bdays <= 14 && (
            <span style={{ ...pill, background: 'var(--warn-tint)', color: 'var(--warn)' }}>
              <Icon name="cake" size={12} color="var(--warn)" />{bdays === 0 ? t('Compleanno oggi!', 'Birthday today!') : bdays === 1 ? t('Compleanno domani', 'Birthday tomorrow') : t(`Compleanno tra ${bdays} giorni`, `Birthday in ${bdays} days`)}
            </span>
          )}
          {onWaitlist && (
            <span style={{ ...pill, background: 'var(--clay-tint)', color: 'var(--clay-ink)', border: '1px solid color-mix(in srgb, var(--clay) 25%, transparent)' }}>
              <Icon name="clock" size={11} color="var(--clay-ink)" />{t("In lista d'attesa", 'On waiting list')}
            </span>
          )}
        </div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, textTransform: 'none' }}>
          {subtitle || t('Cliente', 'Client')}
        </div>
        {line.kind !== 'phone' && (
          <div className="t-sm" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
            <Icon name="phone" size={12} color="var(--muted-2)" />
            {line.kind === 'contact' ? (
              <span>
                {t('Senza telefono, si contatta tramite ', 'No phone, contacted via ')}
                {onOpenClient
                  ? <button type="button" onClick={() => onOpenClient(c.contact.id)} style={{ fontWeight: 700, color: 'var(--clay-ink)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>{c.contact.full_name}</button>
                  : <b>{c.contact.full_name}</b>}
                <span className="tabnum"> · {c.contact.phone}</span>
              </span>
            ) : (
              <span>{t('Senza telefono: niente promemoria né accesso all’app', 'No phone: no reminders or app access')}</span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {c.wa && wa
          ? <a className="dk-btn dk-btn--ghost" style={btnA} href={wa} target="_blank" rel="noreferrer" title={viaTitle}><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</a>
          : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('WhatsApp non disponibile', 'WhatsApp unavailable'), icon: 'whatsapp' })}><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</button>}
        {number
          ? <a className="dk-btn dk-btn--ghost" style={btnA} href={`tel:${number}`} title={viaTitle}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</a>
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
