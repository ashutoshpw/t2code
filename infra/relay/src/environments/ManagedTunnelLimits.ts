import { and, count, eq, isNull, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    /** Runs `reserve` only while the user is under their limit, serialized per user in one transaction. */
    readonly withCapacity: <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R>;
    /** The user's manual cap, which replaces the default and any T3 Chat plan cap. */
    readonly getOverride: (input: {
      readonly userId: string;
    }) => Effect.Effect<number | null, ManagedTunnelLimitPersistenceError>;
  }
>()("t2code-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const loadOverride = (userId: string) =>
    db
      .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
      .from(relayManagedTunnelLimits)
      .where(eq(relayManagedTunnelLimits.userId, userId))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.maxTunnels ?? null),
        Effect.mapError(
          (cause) =>
            new ManagedTunnelLimitPersistenceError({ operation: "load-limit", userId, cause }),
        ),
      );

  return ManagedTunnelLimits.of({
    getOverride: Effect.fn("relay.managed_tunnel_limits.get_override")(function* (input) {
      return yield* loadOverride(input.userId);
    }),
    withCapacity: Effect.fn("relay.managed_tunnel_limits.with_capacity")(function* <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R> {
      const checkAndReserve = Effect.gen(function* () {
        // Held until commit, so the count below sees every reservation that took the lock first.
        yield* db
          .execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`managed-tunnel-limit:${input.userId}`}, 0))`,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "lock-user",
                  userId: input.userId,
                  cause,
                }),
            ),
          );

        const override = yield* loadOverride(input.userId);
        const baseMaxTunnels = override ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

        const pendingCutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, {
            minutes: MANAGED_TUNNEL_PENDING_WINDOW_MINUTES,
          }),
        );
        const countSlots = (environment: typeof eq) =>
          db
            .select({ slots: count() })
            .from(allocation)
            .where(countedAllocations({ ...input, pendingCutoff, environment }))
            .pipe(
              Effect.map((rows) => rows[0]?.slots ?? 0),
              Effect.mapError(
                (cause) =>
                  new ManagedTunnelLimitPersistenceError({
                    operation: "count-tunnels",
                    userId: input.userId,
                    cause,
                  }),
              ),
            );
        const activeTunnels = yield* countSlots(ne);
        if (activeTunnels < baseMaxTunnels) return yield* reserve;

        // An environment that already holds a counted slot relinks without asking T3 Chat,
        // so a downgrade or a T3 Chat outage only blocks new environments.
        if ((yield* countSlots(eq)) > 0) return yield* reserve;

        // A manual override is the exact cap; a T3 Chat plan raises only the default.
        // Runs under the user lock, bounded by the T3 Chat request timeout.
        const maxTunnels =
          t3Chat.available && override === null
            ? Math.max(baseMaxTunnels, yield* t3ChatTunnelLimit(input.userId))
            : baseMaxTunnels;
        if (activeTunnels >= maxTunnels) {
          return yield* new ManagedTunnelLimitExceeded({
            userId: input.userId,
            environmentId: input.environmentId,
            maxTunnels,
            activeTunnels,
          });
        }
        return yield* reserve;
      });

      // Statements inside map their own SqlErrors, so any left here come from opening or committing the transaction.
      return yield* db.$client.withTransaction(checkAndReserve).pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause)
            ? new ManagedTunnelLimitPersistenceError({
                operation: "transaction",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const maxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

      // Exclude this environment so relinking remains idempotent at the account limit.
      const counted = yield* db
        .select({ activeTunnels: count() })
        .from(relayManagedEndpointAllocations)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
            eq(relayEnvironmentLinks.environmentId, relayManagedEndpointAllocations.environmentId),
          ),
        )
        .where(
          and(
            eq(relayManagedEndpointAllocations.userId, input.userId),
            ne(relayManagedEndpointAllocations.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.managedTunnelsEnabled, true),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedTunnelLimitPersistenceError({
                operation: "count-tunnels",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const activeTunnels = counted[0]?.activeTunnels ?? 0;

      if (activeTunnels >= maxTunnels) {
        return yield* new ManagedTunnelLimitExceeded({
          userId: input.userId,
          environmentId: input.environmentId,
          maxTunnels,
          activeTunnels,
        });
      }
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
