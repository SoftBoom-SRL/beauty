// Sostituto di '@youty/shared' per i test: riesporta i VERI helper di
// packages/shared/src/format.js più un ApiError equivalente. Serve perché
// l'indice del pacchetto tira dentro i componenti React, che nei test con
// `node --test` non servono (e senza DOM non si caricano).
export * from '../packages/shared/src/format.js';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}
