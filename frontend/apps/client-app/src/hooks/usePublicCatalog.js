// usePublicCatalog.js — listino e operatrici pubblici del salone.
import { getPublicOperators, getPublicServices } from '../api/client.js';
import { useApiData } from './useApiData.js';

/** Fetch the public price list (categories with services). */
export function usePublicServices(slug) {
  const { data: cats, error } = useApiData(() => getPublicServices(slug), [slug]);
  return { cats, error };
}

/** Fetch the public list of active operators (stylist picker in booking). */
export function usePublicOperators(slug) {
  const { data: operators, error } = useApiData(() => getPublicOperators(slug), [slug]);
  return { operators, error };
}
