// app/useCatalogs.js — i dati di base che tutta la dashboard legge dal
// contesto: salone con impostazioni e sedi, operatrici, servizi, categorie dei
// servizi e delle clienti. Si caricano all'avvio (con la schermata d'attesa di
// ctx.jsx) e si ricaricano uno per uno con `reload.<nome>()`.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { setSalonTz } from '@youty/shared';
import { salonApi } from '../api/core.js';
import { staffApi } from '../api/staff.js';
import { serviceCategoriesApi, servicesApi } from '../api/catalog.js';
import { clientCategoriesApi } from '../api/clients.js';

// Salone non ancora caricato: sempre lo stesso array vuoto, così i useMemo che
// dipendono dalle sedi non si ricalcolano a ogni render.
const NO_LOCATIONS = [];

export function useCatalogs() {
  const [salon, setSalon] = useState(null);                       // SalonOut {id,name,slug,locations,settings,...}
  const [operators, setOperators] = useState([]);                 // [OperatorStatusOut]
  const [services, setServices] = useState([]);                   // [ServiceOut]
  const [serviceCategories, setServiceCategories] = useState([]); // [ServiceCategoryOut]
  const [clientCategories, setClientCategories] = useState([]);   // [ClientCategoryOut]
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(null);

  const reload = useMemo(() => ({
    // Il fuso arriva dal server: l'agenda deve mostrare l'orologio della
    // reception anche da una postazione impostata su un altro fuso.
    salon: () => salonApi.get().then((s) => {
      setSalonTz(s?.settings?.timezone);
      setSalon(s);
    }),
    operators: () => staffApi.list().then(setOperators),
    services: () => servicesApi.list().then(setServices),
    serviceCategories: () => serviceCategoriesApi.list().then(setServiceCategories),
    clientCategories: () => clientCategoriesApi.list().then(setClientCategories),
  }), []);

  const bootLoad = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      await Promise.all([
        reload.salon(),
        reload.operators(),
        reload.serviceCategories(),
        reload.services(),
        reload.clientCategories(),
      ]);
    } catch (err) {
      setBootError(err?.message || 'Errore di caricamento');
    } finally {
      setBooting(false);
    }
  }, [reload]);

  useEffect(() => { bootLoad(); }, [bootLoad]);

  const settings = salon?.settings || null;
  const locations = salon?.locations || NO_LOCATIONS;

  return {
    salon, settings, locations, operators, services, serviceCategories, clientCategories,
    reload, bootLoad, booting, bootError,
  };
}

/** I cataloghi base si ricaricano da soli quando cambiano altrove (feed live).
 *  `subscribe` è quello di useLiveFeed, stabile: dipendere dall'oggetto `live`,
 *  che cambia identità a ogni consegna, voleva dire riscriversi alla lista a
 *  ogni evento. */
export function useLiveCatalogs(subscribe, reload) {
  useEffect(() => subscribe(({ events }) => {
    const has = (re) => events.some((e) => re.test(e.type));
    if (has(/^operator\./)) reload.operators().catch(() => {});
    if (has(/^(service|category|package)\./)) { reload.services().catch(() => {}); reload.serviceCategories().catch(() => {}); }
    if (has(/^client_category\./)) reload.clientCategories().catch(() => {});
    if (has(/^settings\./)) reload.salon().catch(() => {});
  }), [subscribe, reload]);
}
