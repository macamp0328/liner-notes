// Discogs API response type definitions.
// Field presence/types verified against live API in Task 2 (see scripts/discogs-api-notes.md).

export interface DiscogsArtistCredit {
  name: string;
  anv: string; // Artist Name Variation — credited sleeve name when different from canonical name
  join: string;
  role: string;
  tracks: string;
  // Canonical Discogs id, or "unkeyable": 0 when the person is not in the Discogs database
  // (acknowledgments, catering, etc.), null when the API omits the id on a malformed entry
  // (issue #181). Handling of an unkeyable id depends on the field (see ingestion-repository.ts):
  // primary `artists` are skipped, while `extraartists` / track credits are merged by name only.
  id: number | null;
  resource_url: string;
}

export interface DiscogsLabel {
  name: string;
  catno: string;
  entity_type: string; // numeric string: "1"=Label, "23"=Recorded At, "27"=Mixed At, etc.
  entity_type_name: string;
  // Canonical Discogs id; 0/null is unkeyable (malformed/omitted, issue #181) — such labels are
  // skipped in ingestion (there is no name-only Label merge path).
  id: number | null;
  resource_url: string;
  thumbnail_url?: string;
}

// companies[] uses the same shape as labels[]
export type DiscogsCompany = DiscogsLabel;

// The full label entity from GET /labels/{id} — richer than the labels[] embedded in a release.
// We ingest only `parent_label` (the upward edge, issue #332); `sublabels[]`, `profile`, and
// `contact_info` are deliberately omitted. `parent_label` is absent when the label has no parent;
// its `id` can be unkeyable (null/0) on malformed entries, same as DiscogsLabel.id.
export interface DiscogsLabelDetail {
  id: number;
  name: string;
  parent_label?: { id: number | null; name: string };
}

export interface DiscogsFormat {
  name: string;
  qty: string; // NOTE: API returns qty as a string, not a number — must parseInt
  descriptions?: string[];
}

export interface DiscogsTracklistEntry {
  position: string;
  type_: string; // "track" | "heading" | "index" — only "track" entries are real songs
  title: string;
  duration: string; // frequently "" (empty string) — treat as null/absent
  extraartists?: DiscogsArtistCredit[];
}

export interface DiscogsImage {
  type: string; // "primary" | "secondary"
  uri: string;
  uri150: string; // 150px thumbnail URL
  resource_url: string;
  width: number;
  height: number;
}

export interface DiscogsIdentifier {
  type: string; // "Barcode" | "Matrix / Runout" | etc.
  value: string;
  description?: string;
}

export interface DiscogsCommunity {
  have: number;
  want: number;
  rating: {
    count: number;
    average: number;
  };
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year: number;
  country?: string;
  released?: string; // ISO date string e.g. "2019-05-03"
  notes?: string;
  uri: string;
  resource_url: string;
  master_id?: number;
  genres?: string[];
  styles?: string[];
  formats: DiscogsFormat[];
  artists: DiscogsArtistCredit[];
  extraartists?: DiscogsArtistCredit[];
  labels: DiscogsLabel[];
  tracklist: DiscogsTracklistEntry[];
  companies?: DiscogsCompany[];
  images?: DiscogsImage[];
  identifiers?: DiscogsIdentifier[];
  community?: DiscogsCommunity;
}

export interface DiscogsCollectionRelease {
  id: number;
  instance_id: number;
  date_added: string;
  rating: number;
  basic_information: {
    id: number;
    title: string;
    year: number;
    // basic_information omits country, extraartists — must fetch full release
  };
}

export interface DiscogsMasterRelease {
  id: number;
  title: string;
  year: number; // earliest known release year across all versions
}

export interface DiscogsArtistProfile {
  id: number;
  name: string;
  realname?: string;
  profile?: string;
  namevariations?: string[];
  urls?: string[];
  members?: Array<{ id: number; name: string; active: boolean; resource_url: string }>;
}

export interface DiscogsCollectionPage {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
    urls: {
      next?: string;
      last?: string;
    };
  };
  releases: DiscogsCollectionRelease[];
}

export interface DiscogsMasterVersion {
  id: number;
  country?: string;
  major_formats: string[];
  title: string;
  released?: string;
}

export interface DiscogsMasterVersionsPage {
  versions: DiscogsMasterVersion[];
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
}
