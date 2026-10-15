// voiceTools.js — i tre External Tool dell'agente Yourang che prenota al
// telefono (backend: apps/integrations/voice.py), nel formato di «Importa
// strumenti» di Yourang (agente → Strumenti → Strumenti esterni → Importa).
// Stessa forma del file di food (src/lib/voice-tools.ts). Le descrizioni le
// legge l'agente, non l'utente: per questo solo in italiano.

const DATE = {
  type: 'string',
  description: 'Data in formato YYYY-MM-DD, es. 2026-10-02. Converti "domani", "sabato" ecc. nella data esatta',
};
const SERVICES = {
  type: 'string',
  description: 'Id dei servizi scelti, presi da list_services, separati da virgola, es. 12,15',
};

const toolSpecs = (baseUrl) => [
  {
    name: 'list_services',
    displayName: 'Servizi del salone',
    method: 'GET',
    paramsIn: 'query',
    url: `${baseUrl}/api/integrations/voice/services`,
    description: 'Elenca i servizi prenotabili del salone con id, nome, categoria, durata in minuti e prezzo. Usalo appena la cliente dice cosa vuole fare, per trovare gli id dei servizi: non inventare servizi che non sono in elenco.',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_availability',
    displayName: 'Disponibilità salone',
    method: 'GET',
    paramsIn: 'query',
    url: `${baseUrl}/api/integrations/voice/availability`,
    description: 'Controlla gli orari liberi del salone in una data per i servizi scelti. Usalo SEMPRE prima di prenotare. Proponi solo orari presenti in "times"; se "times" è vuoto il salone è pieno o chiuso quel giorno: proponi un altro giorno. Se success è false, correggi i dati indicati in "message" e riprova. Per dire la data alla cliente leggi "date_label".',
    schema: { type: 'object', properties: { date: DATE, services: SERVICES }, required: ['date', 'services'] },
  },
  {
    name: 'create_appointment',
    displayName: 'Prenota appuntamento',
    method: 'POST',
    paramsIn: 'body',
    url: `${baseUrl}/api/integrations/voice/appointments`,
    description: 'Registra l\'appuntamento. Chiamalo SOLO dopo aver letto alla cliente un riepilogo completo (servizi, data da "date_label", orario, nome) e aver ricevuto un sì a QUEL riepilogo: dare il nome non è una conferma. L\'orario deve essere tra quelli di check_availability. Se success è false: con "unavailable" proponi gli orari in "alternatives", con "invalid_request" correggi i dati e riprova. Se "deposit_amount" è maggiore di zero, di\' che riceverà un messaggio con il link per pagare la caparra.',
    schema: {
      type: 'object',
      properties: {
        date: DATE,
        time: { type: 'string', description: 'Orario HH:MM, es. 15:30: uno di quelli restituiti da check_availability' },
        services: SERVICES,
        customer_name: { type: 'string', description: 'Nome e cognome della cliente' },
        customer_phone: { type: 'string', description: 'Telefono della cliente in formato internazionale, es. +393331234567. Se è d\'accordo usa il numero da cui chiama' },
        notes: { type: 'string', description: 'Richieste particolari della cliente, se ne fa' },
      },
      required: ['date', 'time', 'services', 'customer_name', 'customer_phone'],
    },
  },
];

/* La chiave c'è solo se la si passa: in chiaro esiste solo alla generazione.
 * Senza, Yourang importa gli strumenti senza autenticazione e la chiave va
 * aggiunta a mano come Bearer token. Il routing dei parametri va scritto: Yourang
 * manda nel corpo ciò che non ha routing, e una GET il corpo non lo invia. */
export function buildYourangImport(baseUrl, key) {
  return toolSpecs(baseUrl.replace(/\/$/, '')).map((tool) => ({
    tool_name: tool.name,
    display_name: tool.displayName,
    description: tool.description,
    category: 'external',
    category_display_name: 'Prenotazioni',
    webhook_url: tool.url,
    webhook_method: tool.method,
    timeout_seconds: 15,
    auth_method: 'bearer',
    auth_config: key ? { token: key } : {},
    custom_headers: {},
    parameters_schema: tool.schema,
    parameter_routing: Object.fromEntries(
      Object.keys(tool.schema.properties).map((name) => [name, { location: tool.paramsIn }]),
    ),
    is_enabled: true,
  }));
}
