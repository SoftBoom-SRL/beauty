// lib.jsx — da qui gli schermi importano ancora le funzioni pure di ../lib/*.js
// (dove le provano i test con `node --test`).
import { toDateStr } from '@youty/shared';

export { svcLangName, catIcon } from '../lib/catalog.js';
export { nextDays, dayStripLabel, fmtDayMed, relLabel } from '../lib/dates.js';
export { apptServiceNames } from '../lib/appointments.js';
export { mapsUrl, icsDataUrl, downloadIcs } from '../lib/links.js';
export { errToast } from '../lib/errors.js';
export { prefLabel } from '../lib/waitlist.js';

export { toDateStr };
