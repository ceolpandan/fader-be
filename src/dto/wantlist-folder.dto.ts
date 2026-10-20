/** A wantlist folder, with how many items on the wantlist are in it right now. */
export interface WantlistFolderDto {
  id: number;
  name: string;
  itemCount: number;
}

/** Answer to a change of a folder's items: the folder, and the release ids that were not on the wantlist and so were ignored. */
export interface WantlistFolderChangeDto extends WantlistFolderDto {
  ignoredReleaseIds: number[];
}

export interface CreateWantlistFolderRequestDto {
  name: string;
  releaseIds: number[];
}

export interface WantlistFolderItemsRequestDto {
  releaseIds: number[];
}

export interface RenameWantlistFolderRequestDto {
  name: string;
}
