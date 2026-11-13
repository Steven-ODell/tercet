// Deliberately try the complete platform layer before choosing the smaller session.
import { Connection, BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@t3tools/contracts";
import { Persistence } from "@t3tools/client-runtime/platform";
import * as Layer from "effect/Layer";

// The missing platform services are the evidence this spike is intended to collect.
await Effect.runPromise(
  Effect.scoped(
    Layer.build(
      Connection.layer.pipe(
        Layer.provide(
          Layer.succeed(Persistence.ConnectionTargetStore, {
            list: Effect.succeed([
              new BearerConnectionTarget({
                environmentId: EnvironmentId.make("sandbox"),
                label: "sandbox",
                connectionId: "sandbox",
              }),
            ]),
            listDisabled: Effect.succeed([]),
          }),
        ),
      ),
    ),
  ) as Effect.Effect<unknown>,
);
