/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TransitMetadata {
  plate: string;
  route: string;
  destination: string;
  operator: 'TNSTC' | 'SETC' | 'Private' | 'Unknown';
  is_tn_bus: boolean;
  confidence: number;
}

export interface MonitoringState {
  isScanning: boolean;
  lastDetection: TransitMetadata | null;
  history: Array<TransitMetadata & { timestamp: number }>;
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: 'create' | 'update' | 'delete' | 'list' | 'get' | 'write';
  path: string | null;
  authInfo: any;
}
