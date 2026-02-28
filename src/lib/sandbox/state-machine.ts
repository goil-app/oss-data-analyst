import { SandboxState, InvalidTransitionError } from "./types";

const VALID_TRANSITIONS: Record<SandboxState, SandboxState[]> = {
  [SandboxState.Creating]: [SandboxState.Initializing, SandboxState.Error, SandboxState.Destroyed],
  [SandboxState.Initializing]: [SandboxState.Ready, SandboxState.Error, SandboxState.Destroyed],
  [SandboxState.Ready]: [SandboxState.Executing, SandboxState.Destroyed],
  [SandboxState.Executing]: [SandboxState.Idle, SandboxState.Error, SandboxState.Destroyed],
  [SandboxState.Idle]: [SandboxState.Ready, SandboxState.Suspended, SandboxState.Destroyed],
  [SandboxState.Suspended]: [SandboxState.Initializing, SandboxState.Destroyed],
  [SandboxState.Destroyed]: [],
  [SandboxState.Error]: [SandboxState.Creating, SandboxState.Destroyed],
};

export function transition(from: SandboxState, to: SandboxState): SandboxState {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
  return to;
}

export function canTransition(from: SandboxState, to: SandboxState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
