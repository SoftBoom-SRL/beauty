// usePackages — i pacchetti di listino in vendita, per la cassa (banco e
// check-out). GET /api/catalog/packages li dà tutti: quelli disattivati il
// server non li vende (422), quindi qui non si propongono.
import { useResource } from '../../hooks/useResource.js';
import { packagesApi } from '../../api/catalog.js';

/** → i pacchetti attivi, null mentre arrivano (o con `enabled` falso). Se la
 *  lettura fallisce: elenco vuoto, e il modulo lo dice. */
export default function usePackages(enabled = true) {
  const { data } = useResource(() => packagesApi.list(), [], { enabled, fallback: [] });
  if (!enabled || !data) return null;
  return data.filter((p) => p.active !== false);
}
