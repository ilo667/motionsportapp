import { GROUP_TYPE } from '../schedule/training-types';

// What a member's own cancellation costs, by how long before the start it comes and what pays for the training.
// Moves 19:00 ↔ 20:00, the trainer's cancellations and bookings nothing pays for cost nothing
//   group:              under 2 hours → the training is spent (a single visit burns, a pass loses one)
//   personal / split:   a pass: under a day → one training is spent
//                       a single training: under 2 hours → spent; 2 hours to a day → spent, half its price back
export type CancelFee = 'FULL' | 'HALF';

export const GROUP_FREE_HOURS = 2;
export const ASSIGNED_FREE_HOURS = 24;
// Under this, a single personal / split training gives nothing back
export const NO_REFUND_HOURS = 2;

const HOUR_MS = 60 * 60 * 1000;

// packTotal: trainings in what would pay for it (1 = a single training); null = nothing pays for it
export function cancelFee(trainingType: string, msBeforeStart: number, packTotal: number | null): CancelFee | null {
  if (packTotal === null) return null;
  if (trainingType === GROUP_TYPE) return msBeforeStart < GROUP_FREE_HOURS * HOUR_MS ? 'FULL' : null;
  if (msBeforeStart >= ASSIGNED_FREE_HOURS * HOUR_MS) return null;
  if (packTotal > 1) return 'FULL';
  return msBeforeStart < NO_REFUND_HOURS * HOUR_MS ? 'FULL' : 'HALF';
}

// Half of what the single training cost, in whole hryvnias (an odd price rounds down)
export const halfBack = (amountUah: number) => Math.floor(amountUah / 2);
