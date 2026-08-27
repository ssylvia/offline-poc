import { interactiveOfflineJsSdkApproach } from './interactive-offline-js-sdk/descriptor.ts'
import { offlineVideoApproach } from './offline-video/descriptor.ts'
import type { MapApproachDescriptor, MapApproachId } from './types.ts'

export const mapApproaches = [
  interactiveOfflineJsSdkApproach,
  offlineVideoApproach,
] satisfies MapApproachDescriptor[]

export const defaultMapApproachId: MapApproachId = interactiveOfflineJsSdkApproach.id

export function getMapApproachDescriptor(approachId: MapApproachId): MapApproachDescriptor {
  return mapApproaches.find((entry) => entry.id === approachId) ?? interactiveOfflineJsSdkApproach
}

export function isMapApproachId(value: string | null | undefined): value is MapApproachId {
  return mapApproaches.some((entry) => entry.id === value)
}
