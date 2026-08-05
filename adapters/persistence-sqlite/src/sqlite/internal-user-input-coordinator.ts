import type {
  RunEvent,
  RunId,
  UserInputField,
  UserInputRequest,
} from "@tagent/execution/domain";

type InternalUserInputHook = (input: { request: UserInputRequest; event: RunEvent }) => void;
type InternalUserInputCoordinator = (
  runId: RunId,
  prompt: string,
  fields: UserInputField[],
  hook: InternalUserInputHook,
) => UserInputRequest;

const coordinators = new WeakMap<object, InternalUserInputCoordinator>();

export function registerInternalUserInputCoordinator(
  store: object,
  coordinator: InternalUserInputCoordinator,
): void {
  coordinators.set(store, coordinator);
}

export function requestUserInputWithInternalHook(
  store: object,
  runId: RunId,
  prompt: string,
  fields: UserInputField[],
  hook: InternalUserInputHook,
): UserInputRequest {
  const coordinator = coordinators.get(store);
  if (!coordinator) throw new Error("Store internal user-input coordinator is unavailable");
  return coordinator(runId, prompt, fields, hook);
}
