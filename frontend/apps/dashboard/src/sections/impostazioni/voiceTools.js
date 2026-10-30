// voiceTools.js — cosa l'assistente Yourang può leggere e fare (backend:
// integrations/voice.py, TOOL_NAMES e NEEDS). Scrivere porta con sé le letture
// che servono: senza gli id dei servizi o dell'appuntamento l'agente non
// prenota, non sposta e non annulla. Spegnere una lettura spegne chi ne ha bisogno.

export const VOICE_TOOLS = [
  { name: 'list_services', write: false, it: 'Servizi e prezzi', en: 'Services and prices' },
  { name: 'check_availability', write: false, it: 'Orari liberi', en: 'Free times' },
  { name: 'find_appointments', write: false, it: 'Appuntamenti della cliente che chiama', en: 'The caller’s appointments' },
  { name: 'create_appointment', write: true, it: 'Prenotare', en: 'Book' },
  { name: 'reschedule_appointment', write: true, it: 'Spostare un appuntamento', en: 'Reschedule an appointment' },
  { name: 'cancel_appointment', write: true, it: 'Annullare un appuntamento', en: 'Cancel an appointment' },
];

export const NEEDS = {
  create_appointment: ['list_services', 'check_availability'],
  reschedule_appointment: ['find_appointments', 'check_availability'],
  cancel_appointment: ['find_appointments'],
};

/** I permessi dopo aver acceso o spento `name`, nell'ordine di VOICE_TOOLS. */
export function toggleTool(tools, name, on) {
  const next = new Set(tools);
  if (on) {
    next.add(name);
    (NEEDS[name] || []).forEach((n) => next.add(n));
  } else {
    next.delete(name);
    Object.entries(NEEDS).forEach(([w, reads]) => { if (reads.includes(name)) next.delete(w); });
  }
  return VOICE_TOOLS.map((tool) => tool.name).filter((n) => next.has(n));
}
