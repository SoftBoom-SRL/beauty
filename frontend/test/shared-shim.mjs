// Sostituto di '@youty/shared' per i test: riesporta i VERI helper di
// packages/shared/src/format.js più un ApiError equivalente. Serve perché
// l'indice del pacchetto tira dentro i componenti React, che nei test con
// `node --test` non servono (e senza DOM non si caricano).
export * from '../packages/shared/src/format.js';
// Anche le regole del telefono: sono pure come format.js, e i moduli delle
// app che le importano da '@youty/shared' (import CSV, schede) si possono
// provare così come sono.
export * from '../packages/shared/src/phone.js';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}
