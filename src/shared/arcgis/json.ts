export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export function serializeArcGisJson(value: object): JsonObject {
  if (!('toJSON' in value) || typeof value.toJSON !== 'function') {
    throw new Error('An ArcGIS object could not be serialized for offline use.')
  }
  const json: unknown = value.toJSON()
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('An ArcGIS object returned invalid offline JSON.')
  }
  return json as JsonObject
}
