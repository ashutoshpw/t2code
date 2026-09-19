import { requireOptionalNativeModule } from "expo";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

export function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  requireOptionalNativeModule<{ updateSnapshot: (snapshot: string) => void }>(
    "T2SubscriptionWidget",
  )?.updateSnapshot(JSON.stringify(snapshot));
}
