export type VdfValue = string | VdfObject;

export interface VdfObject {
  [key: string]: VdfValue;
}
