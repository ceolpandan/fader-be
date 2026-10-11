/** A filter a collector saved on Explore. */
export interface SavedFilterDto {
  id: number;
  name: string;
  /** The Explore URL query without `page` and without a leading `?`; apply it at `/explore?<query>`. */
  query: string;
  createdAt: string;
}

export interface CreateSavedFilterRequestDto {
  name: string;
  query: string;
}

export interface RenameSavedFilterRequestDto {
  name: string;
}
