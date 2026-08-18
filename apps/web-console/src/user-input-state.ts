export function userInputRequestKey(request: { id: string }): string {
  return request.id;
}

export function userInputValuesForRequest(
  request: { fields: ReadonlyArray<{ key: string }> },
  values: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(request.fields.map((field) => [field.key, values[field.key] ?? ""]));
}
