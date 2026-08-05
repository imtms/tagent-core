import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export function decodeAbi<const Schema extends TSchema>(schema: Schema, input: unknown): Static<Schema> {
  return Value.Parse(schema, input);
}

/** Encodes and validates an outbound value against its published ABI schema. */
export function encodeAbi<const Schema extends TSchema>(schema: Schema, input: Static<Schema>): Static<Schema> {
  return Value.Encode(schema, input) as Static<Schema>;
}
