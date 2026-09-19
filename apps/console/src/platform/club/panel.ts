import type { ClubDetail } from '../api';

/** What every dashboard section receives from `ClubPage`. */
export interface PanelProps {
  club: ClubDetail;
  /** Owner, admin or platform operator. */
  admin: boolean;
  refresh: () => Promise<void>;
  /** Endpoints that return the refreshed detail hand it straight back. */
  setClub: (next: ClubDetail) => void;
}
