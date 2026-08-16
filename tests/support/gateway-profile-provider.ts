import assert from "node:assert/strict";
import {
  AdminMemoryStatusResponseSchema,
  CAPABILITY_PROFILE_DESCRIPTORS,
  CapabilityProfileDetailResponseSchema,
  CapabilityProfileRegistryResponseSchema,
  OperatorContextManifestListResponseSchema,
  OperatorInboxListResponseSchema,
  OperatorSessionSettingsResponseSchema,
  OperatorSkillCatalogResponseSchema,
  OperatorSkillResponseSchema,
  OperatorWorkspaceSkillsResponseSchema,
  adminMemoryStatusFixture,
  capabilityProfileDetailFixtures,
  capabilityProfileRegistryFixture,
  decodeAbi,
  operatorContextManifestListFixture,
  operatorInboxListFixture,
  operatorSessionSettingsFixture,
  operatorSkillCatalogFixture,
  operatorSkillResponseFixture,
  operatorWorkspaceSkillsFixture,
} from "@tagent/abi";
import type { CoreClient } from "@tagent/core-client";
import type { FastifyInstance } from "fastify";

export interface GatewayProfileProviderReport {
  profileCount: number;
  uniqueEndpointCount: number;
  routeCount: number;
  fixtureCount: number;
}

/**
 * Checks the canonical fixtures and a running real Core provider. This is not a
 * Fake Core and deliberately does not simulate Gateway transport failures.
 */
export async function verifyGatewayProfileProvider(
  app: FastifyInstance,
  client: Pick<CoreClient, "getCapabilities" | "listCapabilityProfiles" | "getCapabilityProfile">,
): Promise<GatewayProfileProviderReport> {
  const fixtures: Array<readonly [unknown, unknown]> = [
    [CapabilityProfileRegistryResponseSchema, capabilityProfileRegistryFixture],
    ...capabilityProfileDetailFixtures.map((fixture) => [CapabilityProfileDetailResponseSchema, fixture] as const),
    [OperatorSessionSettingsResponseSchema, operatorSessionSettingsFixture],
    [OperatorInboxListResponseSchema, operatorInboxListFixture],
    [OperatorContextManifestListResponseSchema, operatorContextManifestListFixture],
    [OperatorSkillCatalogResponseSchema, operatorSkillCatalogFixture],
    [OperatorSkillResponseSchema, operatorSkillResponseFixture],
    [OperatorWorkspaceSkillsResponseSchema, operatorWorkspaceSkillsFixture],
    [AdminMemoryStatusResponseSchema, adminMemoryStatusFixture],
  ];
  for (const [schema, fixture] of fixtures) decodeAbi(schema as never, fixture);

  const baseCapabilities = await client.getCapabilities();
  assert.equal(Object.hasOwn(baseCapabilities as object, "profiles"), false, "base capabilities response grew a profiles field");

  const registry = await client.listCapabilityProfiles();
  assert.deepEqual(
    registry.data.profiles.map((profile) => profile.id),
    CAPABILITY_PROFILE_DESCRIPTORS.map((profile) => profile.id),
    "profile registry order or identity drifted",
  );

  const uniqueRoutes = new Set<string>();
  const uniqueEndpoints = new Set<string>();
  for (const expected of CAPABILITY_PROFILE_DESCRIPTORS) {
    const summary = registry.data.profiles.find((profile) => profile.id === expected.id);
    assert.ok(summary, `profile registry omitted ${expected.id}`);
    assert.equal(summary.version, "1.0");
    assert.equal(summary.authorization.status, "available", `${expected.id} is not available to the provider principal`);
    assert.deepEqual(summary.authorization.missingScopes, []);
    assert.deepEqual(summary.authorization.availableEndpointIds, expected.endpointIds);

    const detail = await client.getCapabilityProfile(expected.id);
    assert.deepEqual(detail.data.profile, expected, `${expected.id} detail drifted from the canonical descriptor`);
    assert.deepEqual(detail.data.authorization, summary.authorization);

    for (const endpoint of expected.endpoints) {
      const route = `${endpoint.method} ${endpoint.path}`;
      uniqueRoutes.add(route);
      uniqueEndpoints.add(endpoint.id);
      assert.equal(app.hasRoute({ method: endpoint.method, url: endpoint.path }), true, `${route} is advertised but not registered`);
      if (endpoint.recovery.kind === "durable_receipt_lookup") {
        assert.ok(endpoint.recovery.operationLookupPath, `${endpoint.id} has no receipt lookup path`);
        assert.equal(
          app.hasRoute({ method: "GET", url: endpoint.recovery.operationLookupPath }),
          true,
          `${endpoint.id} advertises an unregistered receipt lookup route`,
        );
      }
    }
  }

  return {
    profileCount: CAPABILITY_PROFILE_DESCRIPTORS.length,
    uniqueEndpointCount: uniqueEndpoints.size,
    routeCount: uniqueRoutes.size,
    fixtureCount: fixtures.length,
  };
}
