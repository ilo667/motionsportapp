import { GROUP_TYPE } from '../schedule/training-types';

// Fee for a member's own cancellation (moves, trainer cancellations and unpaid bookings are free):
// - group: under 2 h, the training is spent
// - personal / split pass: under 24 h, one training is spent
// - personal / split single: under 2 h spent; 2-24 h spent with half the price back
export type CancelFee = 'FULL' | 'HALF';

export const GROUP_FREE_HOURS = 2;
export const ASSIGNED_FREE_HOURS = 24;
// Under this, a single assigned training gives nothing back
export const NO_REFUND_HOURS = 2;

const HOUR_MS = 60 * 60 * 1000;

// packTotal: size of what pays (1 = single training); null = nothing pays, so free
export function cancelFee(trainingType: string, msBeforeStart: number, packTotal: number | null): CancelFee | null {
  if (packTotal === null) return null;
  if (trainingType === GROUP_TYPE) return msBeforeStart < GROUP_FREE_HOURS * HOUR_MS ? 'FULL' : null;
  if (msBeforeStart >= ASSIGNED_FREE_HOURS * HOUR_MS) return null;
  if (packTotal > 1) return 'FULL';
  return msBeforeStart < NO_REFUND_HOURS * HOUR_MS ? 'FULL' : 'HALF';
}

// Whole hryvnias, rounded down
export const halfBack = (amountUah: number) => Math.floor(amountUah / 2);
