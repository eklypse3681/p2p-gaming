import { useLocation } from 'react-router';

/** A game screen opened from a club lobby carries `?club=<id>&table=<id>`. */
export interface ClubContext {
  clubId: string;
  tableId: string | null;
}

export function clubContextFromSearch(search: string): ClubContext | null {
  const params = new URLSearchParams(search);
  const clubId = params.get('club');
  if (!clubId) return null;
  return { clubId, tableId: params.get('table') };
}

export function useClubContext(): ClubContext | null {
  const { search } = useLocation();
  return clubContextFromSearch(search);
}
