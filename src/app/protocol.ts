import type { Outcome, Pin, Plan, Scenario } from '../engine/types';
import type { OptimizeResult } from '../engine/optimize';
import type { Explanation } from '../engine/explain';
import type { ChallengeResult, TruckValue } from '../engine/counterfactual';
import type { Disruption, ReplanResult } from '../engine/disruptions';
import type { PlanStress, RobustReport } from '../engine/uncertainty';
import type { SuiteRow, SuiteSummary } from '../engine/evaluate';

export interface PlanBundle {
  result: OptimizeResult;
  explanation: Explanation;
  fefo: { plan: Plan; outcome: Outcome };
  clearance: { plan: Plan; outcome: Outcome };
}

export interface FrontierPoint {
  weight: number;
  net: number;
  fulfilment: number;
  spoilageRate: number;
  status: string;
}

export interface BenchmarkResult {
  rows: SuiteRow[];
  named: SuiteSummary;
  random: SuiteSummary;
  solver: string;
}

export interface OpArgs {
  plan: { scenario: Scenario; pins: Pin[]; serviceWeight: number };
  challenge: { scenario: Scenario; base: OptimizeResult; pin: Pin };
  truckValues: { scenario: Scenario; base: OptimizeResult };
  frontier: { scenario: Scenario; weights: number[]; pins: Pin[] };
  replan: { scenario: Scenario; plan: Plan; changes: Disruption[]; asOfDay: number };
  stress: { scenario: Scenario; plans: Plan[]; futures: number; seed: number };
  robust: { scenario: Scenario; trainSize: number; testSize: number; seed: number; baseline?: Plan };
  benchmark: { seeds: number[]; futures: number };
  ping: Record<string, never>;
}

export interface OpResult {
  plan: PlanBundle;
  challenge: ChallengeResult;
  truckValues: TruckValue[];
  frontier: FrontierPoint[];
  replan: ReplanResult & { explanation: Explanation };
  stress: PlanStress[];
  robust: RobustReport;
  benchmark: BenchmarkResult;
  ping: { solver: string };
}

export type Op = keyof OpArgs;
