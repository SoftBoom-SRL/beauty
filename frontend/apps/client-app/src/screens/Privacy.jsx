// Privacy.jsx — informativa privacy generata per i saloni senza un sito proprio.
// Vive su /<slug>/privacy; si usa quando il salone non ha impostato un link
// suo (vedi ctx: privacyUrl). Adattata dall'informativa di Yourang: qui il
// TITOLARE è il salone, gestionale e Yourang sono responsabili (art. 28).
// ponytail: solo italiano; versione inglese quando arriva un salone che la chiede.
import { useApp } from '../ctx.jsx';
import { headFont } from '../theme.js';

const UPDATED = '28 ottobre 2026';

const SECTIONS = [
  ['2. Dati che trattiamo', [
    'Dati identificativi e di contatto: nome, cognome, numero di telefono, email.',
    'Dati facoltativi che ci fornisci: data di nascita, genere, preferenze, lingua.',
    'Dati sugli appuntamenti: servizi prenotati, date, spostamenti e cancellazioni, liste d’attesa, mancate presentazioni.',
    'Dati amministrativi: acquisti, pacchetti, gift card, caparre e pagamenti. I dati della carta sono gestiti da Stripe: il salone non vede né conserva il numero della carta.',
    'Schede tecniche e note sui trattamenti (prodotti usati, risultati, eventuali foto) e, solo se ce le comunichi, informazioni su allergie o sensibilità utili a eseguire il trattamento in sicurezza.',
    'Comunicazioni: messaggi WhatsApp, SMS o email scambiati con il salone e, se il salone usa l’assistente telefonico, numero chiamante, registrazione e trascrizione della chiamata.',
  ]],
  ['3. Finalità e base giuridica', [
    'Gestire prenotazioni, appuntamenti, promemoria, liste d’attesa, caparre e pagamenti — esecuzione del contratto (art. 6.1.b GDPR).',
    'Adempiere agli obblighi fiscali e contabili — obbligo di legge (art. 6.1.c GDPR).',
    'Conservare schede tecniche e informazioni su allergie o sensibilità per eseguire i trattamenti in sicurezza — consenso esplicito (art. 9.2.a GDPR), revocabile in qualsiasi momento.',
    'Inviarti offerte, novità, auguri e promozioni — solo con il tuo consenso (art. 6.1.a GDPR), revocabile in qualsiasi momento.',
    'Prevenire abusi e proteggere i sistemi (es. limiti sulle richieste, sicurezza degli accessi) — legittimo interesse (art. 6.1.f GDPR).',
  ]],
  ['4. Conferimento dei dati', [
    'Nome e telefono sono necessari per prenotare: senza non possiamo gestire l’appuntamento.',
    'Tutti gli altri dati sono facoltativi. Il consenso al marketing è libero e non condiziona la prenotazione.',
  ]],
  ['5. Come trattiamo i dati', [
    'I dati sono trattati con strumenti elettronici dal personale del salone autorizzato e istruito, solo per le finalità indicate.',
    'Connessioni cifrate (HTTPS/TLS), accesso al gestionale con credenziali personali e permessi per ruolo, backup periodici.',
  ]],
  ['6. Assistente automatico', [
    'Se il salone usa l’assistente virtuale (telefono o WhatsApp), le tue richieste sono interpretate da un sistema di intelligenza artificiale per rispondere, proporre orari e registrare prenotazioni. L’assistente dichiara sempre di essere automatico.',
    'L’assistente è un supporto: non prende decisioni che producano effetti giuridici su di te, e puoi sempre chiedere di parlare con una persona del salone.',
  ]],
  ['7. Chi riceve i dati', [
    'Il fornitore del gestionale di prenotazione usato dal salone, come responsabile del trattamento (art. 28 GDPR).',
    'Yourang, per l’invio di messaggi WhatsApp, promemoria, automazioni e, se attivo, l’assistente telefonico — responsabile del trattamento.',
    'Stripe, per caparre e pagamenti con carta — titolare autonomo per i dati di pagamento.',
    'Consulenti fiscali e contabili del salone, e le autorità quando lo impone la legge.',
    'I dati non sono venduti né ceduti a terzi per loro finalità di marketing.',
  ]],
  ['8. Trasferimenti fuori dall’UE', [
    'I dati sono trattati principalmente nello Spazio Economico Europeo. Alcuni fornitori (es. Stripe, Meta/WhatsApp, fornitori cloud e di telefonia) possono trattarli negli Stati Uniti sulla base della decisione di adeguatezza EU-US Data Privacy Framework o di clausole contrattuali standard (art. 46 GDPR).',
  ]],
  ['9. Per quanto tempo', [
    'Anagrafica e storico appuntamenti: per la durata del rapporto con il salone; puoi chiederne la cancellazione in qualsiasi momento.',
    'Documenti fiscali e contabili: 10 anni (art. 2220 Codice Civile).',
    'Registrazioni e trascrizioni delle chiamate all’assistente: 12 mesi.',
    'Dati per il marketing: fino alla revoca del consenso.',
  ]],
  ['10. I tuoi diritti', [
    'Accesso (art. 15): sapere se e quali dati trattiamo e averne copia.',
    'Rettifica (art. 16): correggere o completare i tuoi dati.',
    'Cancellazione (art. 17): ottenere la cancellazione dei dati, salvo quelli che la legge ci obbliga a conservare.',
    'Limitazione (art. 18) e portabilità (art. 20): sospendere il trattamento o ricevere i dati in un formato strutturato.',
    'Opposizione (art. 21): opporti al trattamento basato sul legittimo interesse e, sempre, al marketing.',
    'Revoca del consenso, in qualsiasi momento, senza effetto sui trattamenti già fatti.',
    'Per esercitarli contatta il salone ai recapiti indicati sopra: rispondiamo entro 30 giorni (prorogabili di 60 per richieste complesse).',
  ]],
  ['11. Reclamo', [
    'Se ritieni che il trattamento violi il GDPR puoi proporre reclamo al Garante per la protezione dei dati personali — Piazza Venezia 11, 00187 Roma — www.garanteprivacy.it.',
  ]],
  ['12. Cookie e memoria del browser', [
    'L’app usa solo strumenti tecnici necessari al funzionamento (sessione di accesso, lingua scelta), salvati nel tuo browser. Non usiamo cookie di profilazione, analytics o pubblicità, per cui non serve il consenso.',
  ]],
  ['13. Modifiche', [
    'Questa informativa può essere aggiornata per cambi normativi o nuove funzionalità. La data in fondo indica l’ultima versione.',
  ]],
];

export default function Privacy() {
  const { brand } = useApp();
  // Titolare: i dati legali impostati dal salone; altrimenti nome e recapiti.
  const holder = brand.privacyHolder || [brand.name, brand.address, brand.phone && `Tel. ${brand.phone}`].filter(Boolean).join('\n');

  return (
    <div style={{ padding: 'calc(var(--safe-top) + 28px) 24px 48px', maxWidth: 720, margin: '0 auto', lineHeight: 1.55 }}>
      <div style={{ fontFamily: headFont(brand), fontSize: 28, fontWeight: brand.type === 'serif' ? 500 : 800, lineHeight: 1.1 }}>Informativa privacy</div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
        Informativa sul trattamento dei dati personali delle clienti di {brand.name}, ai sensi degli artt. 13 e 14 del Regolamento UE 2016/679 (GDPR).
      </div>

      <h2 className="t-h3" style={{ marginTop: 26, marginBottom: 8 }}>1. Titolare del trattamento</h2>
      <div className="t-body" style={{ whiteSpace: 'pre-line', fontWeight: 600 }}>{holder}</div>
      <div className="t-body" style={{ color: 'var(--muted)', marginTop: 6 }}>
        Il salone non ha nominato un Responsabile della protezione dei dati (DPO), non essendo obbligato. Per ogni richiesta sulla privacy puoi usare i recapiti qui sopra.
      </div>

      {SECTIONS.map(([title, items]) => (
        <section key={title}>
          <h2 className="t-h3" style={{ marginTop: 24, marginBottom: 8 }}>{title}</h2>
          <ul className="t-body" style={{ margin: 0, paddingLeft: 20, color: 'var(--ink-2)' }}>
            {items.map((x) => <li key={x} style={{ marginBottom: 6 }}>{x}</li>)}
          </ul>
        </section>
      ))}

      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 30 }}>Ultimo aggiornamento: {UPDATED}</div>
    </div>
  );
}
