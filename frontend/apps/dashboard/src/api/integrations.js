// api/integrations.js — endpoint delle integrazioni (/api/integrations):
// stato del collegamento Yourang e il flusso OAuth della finestra di servizio
// (oauth/OAuthPopup.jsx). (Regole comuni ai moduli di api/: vedi core.js.)
import { api } from '@youty/shared';

export const yourangApi = {
  status: () => api.get('/api/integrations/yourang/status'),
  /* avvio del flusso: `oauthStart` collega il salone (serve lo staff),
   * `loginStart` entra dalla pagina di accesso; entrambi rispondono
   * { authorize_url, nonce } */
  oauthStart: () => api.get('/api/integrations/yourang/oauth/start'),
  loginStart: () => api.get('/api/integrations/yourang/oauth/login/start'),
  exchange: (body) => api.post('/api/integrations/yourang/oauth/exchange', body),
};

/* Assistente vocale (prenotazioni al telefono): la chiave Bearer che l'agente
 * Yourang usa sulle rotte /voice/... `generate` risponde { key, created_at }:
 * la chiave in chiaro arriva solo lì. */
export const voiceApi = {
  status: () => api.get('/api/integrations/voice/key'),
  generate: () => api.post('/api/integrations/voice/key'),
  revoke: () => api.del('/api/integrations/voice/key'),
};
