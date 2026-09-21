// Sostituisce '@youty/shared' nei probe: riesporta i VERI helper di format.js
// (niente componenti React, che senza node_modules non si caricherebbero).
export * from '../../frontend/packages/shared/src/format.js';
export class ApiError extends Error {}
