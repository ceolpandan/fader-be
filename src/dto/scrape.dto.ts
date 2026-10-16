/** An uploaded list of `Artist - Title` lines and what it matched. */
export interface ScrapeDto {
  id: number;
  name: string;
  createdAt: string;
  /** Distinct releases the lines matched. */
  releaseCount: number;
  /** Lines that matched no release. */
  unmatchedCount: number;
}

export interface CreateScrapeRequestDto {
  name: string;
  /** The file's text: one `Artist - Title` per line. */
  text: string;
}

export interface RenameScrapeRequestDto {
  name: string;
}

export interface ScrapeUnmatchedLineDto {
  /** The line's place in the upload; it names the line when attaching a release to it. */
  position: number;
  line: string;
}

export interface ScrapeUnmatchedDto {
  /** The lines that matched no release (or none yet), as uploaded and in file order. */
  lines: ScrapeUnmatchedLineDto[];
}

export interface AttachReleaseRequestDto {
  /** The Discogs release id to attach to the line; it must already be in the catalogue. */
  releaseId: number;
}
