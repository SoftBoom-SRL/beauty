// app/useActiveLocation.js — la sede attiva: contesto operativo, non solo
// un'etichetta.
import { useMemo } from 'react';
import { useStoredState } from '../hooks/useStoredState.js';

const readLocation = (v) => (v ? Number(v) : null);
const writeLocation = (id) => String(id);

/* Vive nel contesto (non nella sidebar) così agenda, disponibilità e
 * creazione appuntamenti la passano come `location_id`. Persistita per
 * postazione; se la sede salvata non esiste più si torna a quella
 * predefinita. → { locationId, setLocationId, location } */
export function useActiveLocation(locations) {
  const [locationIdRaw, setLocationId] = useStoredState('dk-location', { read: readLocation, write: writeLocation, fallback: null });
  const locationId = useMemo(() => {
    if (!locations.length) return null;
    if (locationIdRaw && locations.some((l) => l.id === locationIdRaw)) return locationIdRaw;
    return (locations.find((l) => l.is_default) || locations[0]).id;
  }, [locations, locationIdRaw]);
  const location = useMemo(() => locations.find((l) => l.id === locationId) || null, [locations, locationId]);
  return { locationId, setLocationId, location };
}
